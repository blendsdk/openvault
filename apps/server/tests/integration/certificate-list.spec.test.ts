import { certificateListQuerySchema } from "@openvault/api-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditCore } from "../../src/audit/runtime.js";
import { CertificateRepository } from "../../src/certificates/repository.js";
import { CertificateService } from "../../src/certificates/service.js";
import { ProjectRepository } from "../../src/projects/repository.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { PolicyService } from "../../src/rbac/policy-service.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { type AuditActors, resetAuditTables, seedAuditActors } from "./helpers/audit-harness.js";
import { createSelfSignedFixture } from "./helpers/certificate-fixtures.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
let base: BaseFixture;
let actors: AuditActors;
let environment: ReturnType<typeof createServerEnvironment>;
let keyring: KeyringProvider;
let service: CertificateService;

interface ImportOptions {
  readonly subject?: string;
  readonly sans?: readonly string[];
  readonly notAfter?: Date;
}

async function importCertificate(name: string, options: ImportOptions = {}): Promise<void> {
  const fixture = await createSelfSignedFixture(options);
  await service.import(actors.orgAdmin, "foundation", {
    name,
    certificatePem: fixture.certificatePem,
    privateKeyPem: fixture.privateKeyPem,
  });
}

async function softDelete(name: string): Promise<void> {
  await testDb.db.executeQuery(
    `UPDATE certificates
        SET deleted_at = now(), purge_after = now() + interval '30 days'
      WHERE project_id = :projectId AND name = :name`,
    { projectId: base.projectId, name },
  );
}

function query(extra: Record<string, unknown> = {}) {
  return certificateListQuerySchema.parse({ limit: 50, ...extra });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
  const core = createAuditCore({ database: testDb.db, keyring });
  const policy = new PolicyService({
    repository: new PolicyRepository(testDb.db),
    audit: core.policyAudit,
    now: () => Date.parse("2026-11-08T12:00:00.000Z"),
  });
  service = new CertificateService({
    database: testDb.db,
    keyring,
    policy,
    audit: core.writer,
    projectRepository: new ProjectRepository(testDb.db),
    repository: new CertificateRepository(),
    certMaxBytes: 131_072,
  });
}, 60_000);

afterAll(async () => {
  keyring.destroy();
  environment.cleanup();
  await testDb.cleanup();
});

beforeEach(async () => {
  await resetAuditTables(testDb.db);
});

describe("certificate list filtering", () => {
  it("should default to active certificates when the query has no status", async () => {
    await importCertificate("default-active");
    await importCertificate("default-deleted");
    await softDelete("default-deleted");

    const parsed = query();
    expect(parsed.status).toBe("active");
    const page = await service.list(actors.orgAdmin, "foundation", parsed);
    const names = page.certificates.map((entry) => entry.name);
    expect(names).toContain("default-active");
    expect(names).not.toContain("default-deleted");
  });

  it("should return only deleted certificates and no private material when status is deleted", async () => {
    await importCertificate("deleted-visible");
    await importCertificate("active-visible");
    await softDelete("deleted-visible");

    const page = await service.list(
      actors.orgAdmin,
      "foundation",
      query({ status: "deleted", q: "visible" }),
    );
    expect(page.certificates).toHaveLength(1);
    const entry = page.certificates[0];
    expect(entry?.name).toBe("deleted-visible");
    expect(entry).not.toHaveProperty("certificatePem");
    expect(entry).not.toHaveProperty("chainPem");
    expect(entry).not.toHaveProperty("privateKeyPem");
  });

  it("should match the certificate name or subject case-insensitively", async () => {
    await importCertificate("api-tls", { subject: "CN=api.payments.internal" });
    await importCertificate("edge-gateway", { subject: "CN=api.edge.internal" });
    await importCertificate("billing", { subject: "CN=billing.internal" });

    for (const term of ["api", "API"]) {
      const page = await service.list(actors.orgAdmin, "foundation", query({ q: term }));
      const names = page.certificates.map((entry) => entry.name);
      expect(names).toContain("api-tls");
      expect(names).toContain("edge-gateway");
      expect(names).not.toContain("billing");
    }
  });

  it("should treat percent as a literal search character", async () => {
    await importCertificate("100-abc");
    const page = await service.list(actors.orgAdmin, "foundation", query({ q: "100%" }));
    expect(page.certificates).toHaveLength(0);
  });

  it("should reject an unknown status value", () => {
    expect(() => certificateListQuerySchema.parse({ status: "archived" })).toThrow();
  });

  it("should intersect deleted status with SAN and expiry filters", async () => {
    const before = new Date("2027-06-01T00:00:00.000Z");
    await importCertificate("intersect-active", {
      subject: "CN=intersect-active",
      sans: ["DNS:api.example.com"],
      notAfter: before,
    });
    await importCertificate("intersect-api", {
      subject: "CN=intersect-api",
      sans: ["DNS:api.example.com"],
      notAfter: before,
    });
    await importCertificate("intersect-other", {
      subject: "CN=intersect-other",
      sans: ["DNS:other.example.com"],
      notAfter: before,
    });
    await importCertificate("intersect-late", {
      subject: "CN=intersect-late",
      sans: ["DNS:api.example.com"],
      notAfter: new Date("2028-06-01T00:00:00.000Z"),
    });
    await softDelete("intersect-api");
    await softDelete("intersect-other");
    await softDelete("intersect-late");

    const page = await service.list(
      actors.orgAdmin,
      "foundation",
      query({
        status: "deleted",
        q: "intersect-",
        san: "DNS:api.example.com",
        expiresAfter: "2026-12-01T00:00:00.000Z",
        expiresBefore: "2027-12-31T23:59:59.999Z",
      }),
    );
    expect(page.certificates.map((entry) => entry.name)).toEqual(["intersect-api"]);
  });

  it("should paginate deleted certificates with the returned cursor", async () => {
    for (const name of ["cursor-a", "cursor-b", "cursor-c"]) {
      await importCertificate(name);
      await softDelete(name);
    }

    const first = await service.list(
      actors.orgAdmin,
      "foundation",
      query({ status: "deleted", q: "cursor-", limit: 1 }),
    );
    expect(first.certificates.map((entry) => entry.name)).toEqual(["cursor-a"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await service.list(
      actors.orgAdmin,
      "foundation",
      query({
        status: "deleted",
        q: "cursor-",
        limit: 1,
        cursor: first.nextCursor,
      }),
    );
    expect(second.certificates.map((entry) => entry.name)).toEqual(["cursor-b"]);
    expect(second.nextCursor).not.toBeNull();

    const third = await service.list(
      actors.orgAdmin,
      "foundation",
      query({
        status: "deleted",
        q: "cursor-",
        limit: 1,
        cursor: second.nextCursor,
      }),
    );
    expect(third.certificates.map((entry) => entry.name)).toEqual(["cursor-c"]);
    expect(third.nextCursor).toBeNull();
  });
});
