import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIdentityRuntime } from "../../src/identity/identity-runtime.js";
import type {
  PolicyAuditPort,
  PolicyDecisionEvent,
  PolicyMutationEvent,
} from "../../src/rbac/audit.js";
import { PolicyUnavailableError } from "../../src/rbac/errors.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { type PolicyResource, PolicyService } from "../../src/rbac/policy-service.js";
import { createPolicyRuntime } from "../../src/rbac/runtime.js";
import { type BaseFixture, seedBase, testUlid } from "./helpers/fixtures.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

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

let testDb: TestDatabase;
let base: BaseFixture;
let audit: RecordingAudit;
let policy: PolicyService;
let nextUser = 5_000;
let nextAssignment = 6_000;

async function insertUser(status: "active" | "disabled" = "active"): Promise<string> {
  nextUser += 1;
  const id = testUlid(nextUser);
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status, disabled_at)
     VALUES (:id, 'user', :name, :email, :status,
             CASE WHEN :status = 'disabled' THEN now() ELSE NULL END)`,
    {
      id,
      name: `Policy Impl ${id}`,
      email: `policy-impl-${id.toLowerCase()}@example.test`,
      status,
    },
  );
  return id;
}

async function assign(
  principalId: string,
  role: string,
  scopeType: "org" | "project" | "object",
  scopeId: string,
  expiresAt: string | null = null,
): Promise<void> {
  nextAssignment += 1;
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments
       (id, principal_id, role, scope_type, scope_id, granted_by, expires_at)
     VALUES (:id, :principalId, :role, :scopeType, :scopeId, :grantedBy, :expiresAt)`,
    {
      id: testUlid(nextAssignment),
      principalId,
      role,
      scopeType,
      scopeId,
      grantedBy: base.userId,
      expiresAt,
    },
  );
}

function project(id: string): Extract<PolicyResource, { type: "project" }> {
  return { type: "project", id };
}

function secret(id: string, projectId: string): Extract<PolicyResource, { type: "secret" }> {
  return { type: "secret", id, projectId };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  audit = new RecordingAudit();
  policy = new PolicyService({
    repository: new PolicyRepository(testDb.db),
    audit,
  });
}, 30_000);

afterAll(async () => {
  await testDb?.cleanup();
});

describe("decision reason selection", () => {
  it("should distinguish no assignment, wrong scope, and expired assignment", async () => {
    const none = await insertUser();
    expect(
      (await policy.authorize(none, "secret.read", secret(base.secretId, base.projectId))).reason,
    ).toBe("no_assignment");

    const wrongScope = await insertUser();
    await assign(wrongScope, "secrets.reader", "project", testUlid(6_100));
    expect(
      (await policy.authorize(wrongScope, "secret.read", secret(base.secretId, base.projectId)))
        .reason,
    ).toBe("scope_mismatch");

    const expired = await insertUser();
    await assign(expired, "secrets.reader", "project", base.projectId, "2020-01-01T00:00:00.000Z");
    expect(
      (await policy.authorize(expired, "secret.read", secret(base.secretId, base.projectId)))
        .reason,
    ).toBe("expired_assignment");
  });

  it("should prefer an active assignment over an expired matching one", async () => {
    const user = await insertUser();
    await assign(user, "secrets.reader", "project", base.projectId, "2020-01-01T00:00:00.000Z");
    await assign(user, "project.admin", "project", base.projectId);
    const decision = await policy.authorize(
      user,
      "secret.read",
      secret(base.secretId, base.projectId),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.assignment?.role).toBe("project.admin");
  });

  it("should return unknown_principal with the current version", async () => {
    const decision = await policy.authorize(
      testUlid(6_200),
      "secret.read",
      secret(base.secretId, base.projectId),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("unknown_principal");
    expect(decision.policyVersion).toBeGreaterThan(0);
  });
});

describe("version and list internals", () => {
  it("should use a bumped version on the next decision", async () => {
    const user = await insertUser();
    await assign(user, "org.admin", "org", "org");
    const before = await policy.authorize(user, "project.read", project(base.projectId));
    const newVersion = await new PolicyRepository(testDb.db).bumpPolicyVersion(testDb.db);
    const after = await policy.authorize(user, "project.read", project(base.projectId));
    expect(after.policyVersion).toBe(newVersion);
    expect(after.policyVersion).toBeGreaterThan(before.policyVersion);
  });

  it("should keep an uncommitted version bump out of a concurrent decision", async () => {
    const user = await insertUser();
    await assign(user, "org.admin", "org", "org");
    const before = await policy.authorize(user, "project.read", project(base.projectId));

    let release: () => void = () => undefined;
    let bumped: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      bumped = resolve;
    });
    const transaction = testDb.db.withTransaction(async (tx) => {
      await new PolicyRepository(tx).bumpPolicyVersion(tx);
      bumped();
      await gate;
    });
    await started;
    const during = await policy.authorize(user, "project.read", project(base.projectId));
    expect(during.policyVersion).toBe(before.policyVersion);
    release();
    await transaction;

    const after = await policy.authorize(user, "project.read", project(base.projectId));
    expect(after.policyVersion).toBeGreaterThan(before.policyVersion);
  });

  it("should deny a project-only actor at another project in a list decision", async () => {
    const user = await insertUser();
    await assign(user, "auditor", "project", base.projectId);
    const denied = await policy.authorizeList(user, "assignment.read", project(testUlid(6_300)));
    expect(denied.decision.allowed).toBe(false);
    expect(denied.decision.reason).toBe("scope_mismatch");
    expect(denied.visibility).toEqual({ kind: "projects", projectIds: [] });
  });

  it("should deduplicate readable project ids", async () => {
    const user = await insertUser();
    await assign(user, "auditor", "project", base.projectId);
    await assign(user, "reader", "project", base.projectId);
    expect(await policy.readableProjectIds(user, "identity.read")).toEqual([base.projectId]);
  });

  it("should deny an inactive actor in capabilities and any-scope checks", async () => {
    const user = await insertUser("disabled");
    await assign(user, "org.admin", "org", "org");
    expect(await policy.capabilitiesFor(user, secret(base.secretId, base.projectId))).toEqual({
      canRead: false,
      canWrite: false,
      canDelete: false,
      canPurge: false,
      canManage: false,
    });
    expect((await policy.hasAny(user, "secret.read")).reason).toBe("inactive_principal");
  });

  it("should report an expired any-scope assignment", async () => {
    const user = await insertUser();
    await assign(user, "org.admin", "org", "org", "2020-01-01T00:00:00.000Z");
    expect((await policy.hasAny(user, "secret.read")).reason).toBe("expired_assignment");
  });
});

describe("grant and catalog internals", () => {
  it("should deny a grant for an unknown or inactive actor", async () => {
    const unknown = await policy.authorizeGrant(
      testUlid(6_400),
      "secrets.reader",
      project(base.projectId),
    );
    expect(unknown.reason).toBe("unknown_principal");

    const disabled = await insertUser("disabled");
    await assign(disabled, "org.admin", "org", "org");
    expect(
      (await policy.authorizeGrant(disabled, "secrets.reader", project(base.projectId))).reason,
    ).toBe("inactive_principal");
  });

  it("should deny a service actor a grant", async () => {
    await assign(base.serviceId, "org.admin", "org", "org");
    expect(
      (await policy.authorizeGrant(base.serviceId, "secrets.reader", project(base.projectId)))
        .reason,
    ).toBe("service_control_plane");
  });

  it("should build a catalog with the current version", async () => {
    const catalog = await policy.catalog();
    expect(catalog.actions).toHaveLength(25);
    expect(catalog.roles).toHaveLength(9);
    expect(catalog.policyVersion).toBeGreaterThan(0);
  });

  it("should share the policy service through the runtime composition", async () => {
    const environment = createServerEnvironment({ OPENVAULT_DB_URL: testDb.url });
    try {
      const runtime = createPolicyRuntime({ database: testDb.db });
      const identityRuntime = createIdentityRuntime({
        database: testDb.db,
        config: environment.config,
        policyService: runtime.service,
      });
      expect(identityRuntime.policyService).toBe(runtime.service);
      expect(runtime.audit).toBeDefined();
      await expect(runtime.service.catalog()).resolves.toMatchObject({
        policyVersion: expect.any(Number),
      });
    } finally {
      environment.cleanup();
    }
  });

  it("should fail closed when the version row is unavailable", async () => {
    await testDb.db.executeQuery("DELETE FROM policy_state");
    const failing = new PolicyService({
      repository: new PolicyRepository(testDb.db),
      audit,
    });
    await expect(
      failing.authorize(base.userId, "secret.read", secret(base.secretId, base.projectId)),
    ).rejects.toBeInstanceOf(PolicyUnavailableError);
    await testDb.db.executeQuery("INSERT INTO policy_state (id, version) VALUES (1, 1)");
  });
});
