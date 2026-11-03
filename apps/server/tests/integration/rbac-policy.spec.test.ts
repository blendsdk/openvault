import { networkInterfaces } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestApplication } from "../../src/app.js";
import type {
  PolicyAuditPort,
  PolicyDecisionEvent,
  PolicyMutationEvent,
} from "../../src/rbac/audit.js";
import { PolicyUnavailableError } from "../../src/rbac/errors.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { type PolicyResource, PolicyService } from "../../src/rbac/policy-service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { TlsMaterial } from "../../src/transport/tls.js";
import { type BaseFixture, seedBase, testUlid } from "./helpers/fixtures.js";
import { testRequest } from "./helpers/https.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

function externalIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (
        String(entry.family) === "IPv4" &&
        !entry.internal &&
        !entry.address.startsWith("169.254.")
      ) {
        return entry.address;
      }
    }
  }
  return undefined;
}

const trustedHost = externalIpv4();

const roleCatalogSchema = z.object({
  actions: z.array(
    z.object({ name: z.string(), plane: z.enum(["control", "data"]), description: z.string() }),
  ),
  roles: z.array(
    z.object({
      name: z.string(),
      actions: z.array(z.string()),
      scopes: z.array(z.enum(["org", "project", "object"])),
    }),
  ),
  policyVersion: z.number().int().nonnegative(),
});

class RecordingAudit implements PolicyAuditPort {
  readonly decisions: PolicyDecisionEvent[] = [];
  readonly mutations: PolicyMutationEvent[] = [];

  async recordDecision(event: PolicyDecisionEvent): Promise<void> {
    this.decisions.push(event);
  }

  async recordMutation(event: PolicyMutationEvent): Promise<void> {
    this.mutations.push(event);
  }
}

class FailingAudit implements PolicyAuditPort {
  async recordDecision(): Promise<void> {
    throw new Error("audit unavailable");
  }

  async recordMutation(): Promise<void> {
    throw new Error("audit unavailable");
  }
}

interface Fixture {
  readonly projectA: string;
  readonly projectB: string;
  readonly secretA: string;
  readonly secretB: string;
  readonly certificateA: string;
  readonly certificateB: string;
  readonly orgAdmin: string;
  readonly projectAdmin: string;
  readonly reader: string;
  readonly objectReader: string;
  readonly certificateReader: string;
  readonly auditor: string;
}

let testDb: TestDatabase;
let base: BaseFixture;
let fixture: Fixture;
let audit: RecordingAudit;
let policy: PolicyService;
let nextUser = 1_000;
let nextAssignment = 2_000;

async function insertUser(status: "active" | "disabled" = "active"): Promise<string> {
  nextUser += 1;
  const id = testUlid(nextUser);
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status, disabled_at)
     VALUES (:id, 'user', :name, :email, :status,
             CASE WHEN :status = 'disabled' THEN now() ELSE NULL END)`,
    { id, name: `RBAC ${id}`, email: `rbac-${id.toLowerCase()}@example.test`, status },
  );
  return id;
}

async function assign(
  principalId: string,
  role: string,
  scopeType: "org" | "project" | "object",
  scopeId: string,
  expiresAt: string | null = null,
): Promise<string> {
  nextAssignment += 1;
  const id = testUlid(nextAssignment);
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments
       (id, principal_id, role, scope_type, scope_id, granted_by, expires_at)
     VALUES (:id, :principalId, :role, :scopeType, :scopeId, :grantedBy, :expiresAt)`,
    { id, principalId, role, scopeType, scopeId, grantedBy: base.userId, expiresAt },
  );
  return id;
}

function org(): Extract<PolicyResource, { type: "org" }> {
  return { type: "org", id: "org" };
}

function project(id: string): Extract<PolicyResource, { type: "project" }> {
  return { type: "project", id };
}

function secret(id: string, projectId: string): Extract<PolicyResource, { type: "secret" }> {
  return { type: "secret", id, projectId };
}

function certificate(
  id: string,
  projectId: string,
): Extract<PolicyResource, { type: "certificate" }> {
  return { type: "certificate", id, projectId };
}

function serviceIdentity(
  id: string,
  projectId: string,
): Extract<PolicyResource, { type: "identity" }> {
  return { type: "identity", id, projectId };
}

function humanIdentity(id: string): Extract<PolicyResource, { type: "identity" }> {
  return { type: "identity", id };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  const projectB = testUlid(900);
  await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, 'rbac-project-b')", {
    id: projectB,
  });
  const secretB = testUlid(901);
  await testDb.db.executeQuery(
    "INSERT INTO secrets (id, project_id, name) VALUES (:id, :projectId, 'rbac-secret-b')",
    { id: secretB, projectId: projectB },
  );
  const certificateB = testUlid(902);
  await testDb.db.executeQuery(
    "INSERT INTO certificates (id, project_id, name) VALUES (:id, :projectId, 'rbac-cert-b')",
    { id: certificateB, projectId: projectB },
  );

  fixture = {
    projectA: base.projectId,
    projectB,
    secretA: base.secretId,
    secretB,
    certificateA: base.certificateId,
    certificateB,
    orgAdmin: await insertUser(),
    projectAdmin: await insertUser(),
    reader: await insertUser(),
    objectReader: await insertUser(),
    certificateReader: await insertUser(),
    auditor: await insertUser(),
  };
  await assign(fixture.orgAdmin, "org.admin", "org", "org");
  await assign(fixture.projectAdmin, "project.admin", "project", fixture.projectA);
  await assign(fixture.reader, "reader", "project", fixture.projectA);
  await assign(fixture.objectReader, "secrets.reader", "object", fixture.secretA);
  await assign(fixture.certificateReader, "certificates.reader", "project", fixture.projectA);
  await assign(fixture.auditor, "auditor", "project", fixture.projectA);

  audit = new RecordingAudit();
  policy = new PolicyService({
    repository: new PolicyRepository(testDb.db),
    audit,
  });
}, 30_000);

afterAll(async () => {
  await testDb?.cleanup();
});

describe("policy evaluator scopes", () => {
  it("should deny every action when the principal has no assignment", async () => {
    const user = await insertUser();
    const decision = await policy.authorize(user, "project.read", project(fixture.projectA));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("no_assignment");
  });

  it("should let an org assignment cover projects, objects, and identities", async () => {
    for (const resource of [
      project(fixture.projectA),
      secret(fixture.secretA, fixture.projectA),
      certificate(fixture.certificateA, fixture.projectA),
      serviceIdentity(base.serviceId, fixture.projectA),
      humanIdentity(base.userId),
    ]) {
      const decision = await policy.authorize(fixture.orgAdmin, "project.read", resource);
      expect(decision.allowed, resource.type).toBe(true);
    }
    const secretDecision = await policy.authorize(
      fixture.orgAdmin,
      "secret.read",
      secret(fixture.secretA, fixture.projectA),
    );
    expect(secretDecision.allowed).toBe(true);
  });

  it("should let a project assignment cover its project and objects only", async () => {
    expect(
      (await policy.authorize(fixture.projectAdmin, "project.read", project(fixture.projectA)))
        .allowed,
    ).toBe(true);
    expect(
      (
        await policy.authorize(
          fixture.projectAdmin,
          "secret.read",
          secret(fixture.secretA, fixture.projectA),
        )
      ).allowed,
    ).toBe(true);
    const foreign = await policy.authorize(
      fixture.projectAdmin,
      "secret.read",
      secret(fixture.secretB, fixture.projectB),
    );
    expect(foreign.allowed).toBe(false);
    expect(foreign.reason).toBe("scope_mismatch");
  });

  it("should let an object assignment cover exactly one object and no list", async () => {
    expect(
      (
        await policy.authorize(
          fixture.objectReader,
          "secret.read",
          secret(fixture.secretA, fixture.projectA),
        )
      ).allowed,
    ).toBe(true);
    for (const resource of [
      secret(fixture.secretB, fixture.projectB),
      project(fixture.projectA),
      certificate(fixture.certificateA, fixture.projectA),
    ]) {
      const decision = await policy.authorize(fixture.objectReader, "secret.read", resource);
      expect(decision.allowed, resource.type).toBe(false);
    }
  });

  it("should never inherit upward from an object assignment", async () => {
    const decision = await policy.authorize(
      fixture.objectReader,
      "project.read",
      project(fixture.projectA),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("no_assignment");
  });
});

describe("principal and assignment state", () => {
  it("should deny an inactive principal", async () => {
    const user = await insertUser("disabled");
    await assign(user, "org.admin", "org", "org");
    const decision = await policy.authorize(user, "project.read", project(fixture.projectA));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("inactive_principal");
  });

  it("should deny an expired assignment and allow a future one", async () => {
    const expired = await insertUser();
    await assign(expired, "org.admin", "org", "org", "2020-01-01T00:00:00.000Z");
    const expiredDecision = await policy.authorize(
      expired,
      "project.read",
      project(fixture.projectA),
    );
    expect(expiredDecision.reason).toBe("expired_assignment");

    const future = await insertUser();
    await assign(future, "org.admin", "org", "org", "2099-01-01T00:00:00.000Z");
    expect(
      (await policy.authorize(future, "project.read", project(fixture.projectA))).allowed,
    ).toBe(true);
  });

  it("should deny control-plane actions to a service principal even with a forged row", async () => {
    await assign(base.serviceId, "org.admin", "org", "org");
    const decision = await policy.authorize(
      base.serviceId,
      "project.read",
      project(fixture.projectA),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("service_control_plane");
  });

  it("should ignore a role assigned at an ineligible scope", async () => {
    const user = await insertUser();
    await assign(user, "org.admin", "project", fixture.projectA);
    const decision = await policy.authorize(user, "project.read", project(fixture.projectA));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("scope_mismatch");
    const create = await policy.authorize(user, "project.create", org());
    expect(create.allowed).toBe(false);
  });

  it("should honor the role matrix and scope eligibility", async () => {
    expect(
      (await policy.authorize(fixture.reader, "certificate.list", project(fixture.projectA)))
        .allowed,
    ).toBe(true);
    expect(
      (
        await policy.authorize(
          fixture.reader,
          "secret.read",
          secret(fixture.secretA, fixture.projectA),
        )
      ).allowed,
    ).toBe(false);
  });

  it("should require org scope for a human identity", async () => {
    const denied = await policy.authorize(
      fixture.projectAdmin,
      "identity.read",
      humanIdentity(base.userId),
    );
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("scope_mismatch");
    expect(
      (await policy.authorize(fixture.orgAdmin, "identity.read", humanIdentity(base.userId)))
        .allowed,
    ).toBe(true);
  });
});

describe("decision evidence and capabilities", () => {
  it("should return the policy version and matched assignment", async () => {
    const decision = await policy.authorize(
      fixture.projectAdmin,
      "secret.read",
      secret(fixture.secretA, fixture.projectA),
    );
    expect(decision).toMatchObject({
      allowed: true,
      reason: "allowed",
      actorId: fixture.projectAdmin,
      actorKind: "user",
      action: "secret.read",
      scope: { type: "project", id: fixture.projectA },
    });
    expect(decision.policyVersion).toBeGreaterThan(0);
    expect(decision.assignment?.role).toBe("project.admin");
  });

  it("should return capability flags from the same matrix", async () => {
    expect(
      await policy.capabilitiesFor(fixture.projectAdmin, secret(fixture.secretA, fixture.projectA)),
    ).toEqual({
      canRead: true,
      canWrite: true,
      canDelete: true,
      canPurge: true,
      canManage: true,
    });
    expect(
      await policy.capabilitiesFor(fixture.objectReader, secret(fixture.secretA, fixture.projectA)),
    ).toEqual({
      canRead: true,
      canWrite: false,
      canDelete: false,
      canPurge: false,
      canManage: false,
    });
    expect(
      await policy.capabilitiesFor(
        fixture.certificateReader,
        certificate(fixture.certificateA, fixture.projectA),
      ),
    ).toEqual({
      canRead: true,
      canWrite: false,
      canDelete: false,
      canPurge: false,
      canManage: false,
    });
  });

  it("should not audit a capability projection", async () => {
    audit.decisions.length = 0;
    await policy.capabilitiesFor(fixture.reader, secret(fixture.secretA, fixture.projectA));
    expect(audit.decisions).toHaveLength(0);
  });

  it("should audit exactly one event per decision and fail closed on audit failure", async () => {
    audit.decisions.length = 0;
    await policy.authorize(
      fixture.objectReader,
      "secret.read",
      secret(fixture.secretA, fixture.projectA),
    );
    expect(audit.decisions).toHaveLength(1);
    expect(audit.decisions[0]).toMatchObject({
      actorId: fixture.objectReader,
      action: "secret.read",
      result: "allow",
      reason: "allowed",
    });

    const failing = new PolicyService({
      repository: new PolicyRepository(testDb.db),
      audit: new FailingAudit(),
    });
    await expect(
      failing.authorize(
        fixture.objectReader,
        "secret.read",
        secret(fixture.secretA, fixture.projectA),
      ),
    ).rejects.toBeInstanceOf(PolicyUnavailableError);
  });

  it("should answer any-scope checks and list visibility", async () => {
    expect(await policy.hasAny(fixture.projectAdmin, "identity.read")).toMatchObject({
      allowed: true,
      scope: { type: "system", id: null },
    });
    expect(await policy.hasAny(fixture.reader, "identity.read")).toMatchObject({
      allowed: false,
      scope: { type: "system", id: null },
    });

    const all = await policy.authorizeList(fixture.orgAdmin, "assignment.read", org());
    expect(all.visibility).toEqual({ kind: "all" });
    const projects = await policy.authorizeList(
      fixture.auditor,
      "assignment.read",
      project(fixture.projectA),
    );
    expect(projects.visibility).toEqual({ kind: "projects", projectIds: [fixture.projectA] });
    const denied = await policy.authorizeList(
      fixture.auditor,
      "assignment.read",
      project(fixture.projectB),
    );
    expect(denied.decision.allowed).toBe(false);
    expect(denied.decision.reason).toBe("scope_mismatch");
  });

  it("should enforce the grant guards", async () => {
    const grant = await policy.authorizeGrant(
      fixture.projectAdmin,
      "secrets.reader",
      project(fixture.projectA),
    );
    expect(grant.allowed).toBe(true);

    const otherProject = await policy.authorizeGrant(
      fixture.projectAdmin,
      "secrets.reader",
      project(fixture.projectB),
    );
    expect(otherProject.allowed).toBe(false);
    expect(otherProject.reason).toBe("grant_scope_not_covered");

    const auditor = await policy.authorizeGrant(
      fixture.projectAdmin,
      "auditor",
      project(fixture.projectA),
    );
    expect(auditor.allowed).toBe(false);
    expect(auditor.reason).toBe("grant_role_not_subset");

    const orgAdminGrant = await policy.authorizeGrant(fixture.projectAdmin, "org.admin", org());
    expect(orgAdminGrant.allowed).toBe(false);
    expect(orgAdminGrant.reason).toBe("grant_scope_not_covered");

    const invalidScope = await policy.authorizeGrant(
      fixture.orgAdmin,
      "project.admin",
      secret(fixture.secretA, fixture.projectA),
    );
    expect(invalidScope.allowed).toBe(false);
    expect(invalidScope.reason).toBe("invalid_scope");
  });
});

describe("role catalog route", () => {
  it.skipIf(trustedHost === undefined)(
    "should serve the public catalog without a session",
    async () => {
      const environment = createServerEnvironment({
        OPENVAULT_DB_URL: testDb.url,
        OPENVAULT_PROXY_CIDRS:
          trustedHost === undefined
            ? "127.0.0.1/32,::1/128"
            : `127.0.0.1/32,::1/128,${trustedHost}/32`,
      });
      const keyring = await KeyringProvider.load(environment.keyringPath);
      const tls = TlsMaterial.load(environment.config);
      const app = await createTestApplication(environment.config, {
        database: testDb.db,
        tls,
        keyring,
      });
      const handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
      try {
        const response = await testRequest({
          port: handle.adminPort,
          path: "/v1/meta/roles",
          host: trustedHost ?? "127.0.0.1",
          ca: environment.tls.caPem,
          servername: "localhost",
        });
        expect(response.status, response.body).toBe(200);
        const body = roleCatalogSchema.parse((response.json as { data: unknown }).data);
        expect(body.actions).toHaveLength(25);
        expect(body.roles).toHaveLength(9);
        expect(body.policyVersion).toBeGreaterThan(0);
        expect(JSON.stringify(body)).not.toContain(base.serviceId);
      } finally {
        await handle.stop();
        environment.cleanup();
      }
    },
    30_000,
  );
});
