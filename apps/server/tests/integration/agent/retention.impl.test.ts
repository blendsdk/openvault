import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentMaintenanceService,
  DatabaseAgentMaintenanceRepository,
} from "../../../src/agent/agent-maintenance.js";
import { testUlid } from "../helpers/fixtures.js";
import {
  applyMigrations,
  createTestDatabase,
  type TestDatabase,
} from "../helpers/test-database.js";

let testDb: TestDatabase;
let projectId: string;
let serviceId: string;
let actorId: string;
let nextId = 8_000;

function id(): string {
  nextId += 1;
  return testUlid(nextId);
}

const logger = {
  info: async () => undefined,
  warn: async () => undefined,
  debug: async () => undefined,
  error: async () => undefined,
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  actorId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    { id: actorId, name: "Retention Impl", email: `retention-impl-${actorId}@example.test` },
  );
  projectId = id();
  await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, 'retention-impl')", {
    id: projectId,
  });
  serviceId = id();
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, owner_project_id)
     VALUES (:id, 'service', 'retention-impl-service', :projectId)`,
    { id: serviceId, projectId },
  );
}, 30_000);

afterAll(async () => {
  await testDb?.cleanup();
});

async function insertToken(
  expiresAt: string,
  usedAt: string | null = null,
  revokedAt: string | null = null,
): Promise<string> {
  const tokenId = id();
  await testDb.db.executeQuery(
    `INSERT INTO join_tokens
       (id, token_hash, principal_id, project_id, expires_at, used_at, revoked_at, created_by)
     VALUES
       (:id, :tokenHash, :principalId, :projectId, :expiresAt, :usedAt, :revokedAt, :createdBy)`,
    {
      id: tokenId,
      tokenHash: randomBytes(32),
      principalId: serviceId,
      projectId,
      expiresAt,
      usedAt,
      revokedAt,
      createdBy: actorId,
    },
  );
  return tokenId;
}

async function insertCertificate(notAfter: string, revokedAt: string | null): Promise<string> {
  const certificateId = id();
  await testDb.db.executeQuery(
    `INSERT INTO workload_certs
       (id, principal_id, serial, fingerprint, not_before, not_after, revoked_at)
     VALUES
       (:id, :principalId, :serial, :fingerprint, '2020-01-01T00:00:00.000Z', :notAfter, :revokedAt)`,
    {
      id: certificateId,
      principalId: serviceId,
      serial: randomBytes(16).toString("hex"),
      fingerprint: randomBytes(32).toString("hex"),
      notAfter,
      revokedAt,
    },
  );
  return certificateId;
}

async function exists(table: "join_tokens" | "workload_certs", id: string): Promise<boolean> {
  const result = await testDb.db.executeQuery<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table} WHERE id = :id`,
    { id },
  );
  return (result.records[0]?.count ?? 0) === 1;
}

describe("retention repository boundaries", () => {
  it("should keep tokens inside 24 hours and delete older ones in batches", async () => {
    const fresh = await insertToken("2099-01-01T00:00:00.000Z");
    const oldOne = await insertToken(
      "2026-11-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
    );
    const oldTwo = await insertToken(
      "2026-11-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
    );
    const repository = new DatabaseAgentMaintenanceRepository(testDb.db);
    expect(await repository.cleanupTokens(1)).toBe(1);
    expect(await repository.cleanupTokens(1)).toBe(1);
    expect(await exists("join_tokens", fresh)).toBe(true);
    expect(await exists("join_tokens", oldOne)).toBe(false);
    expect(await exists("join_tokens", oldTwo)).toBe(false);
  });

  it("should retain a live certificate and a recent post-expiry revocation", async () => {
    const live = await insertCertificate("2099-01-01T00:00:00.000Z", null);
    const recentRevoke = await insertCertificate(
      "2026-10-01T00:00:00.000Z",
      "2026-11-02T00:00:00.000Z",
    );
    const oldRevoke = await insertCertificate(
      "2026-10-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    );
    const repository = new DatabaseAgentMaintenanceRepository(testDb.db);
    expect(await repository.cleanupCertificates(1_000)).toBeGreaterThanOrEqual(1);
    expect(await exists("workload_certs", live)).toBe(true);
    expect(await exists("workload_certs", recentRevoke)).toBe(true);
    expect(await exists("workload_certs", oldRevoke)).toBe(false);
  });

  it("should run both cleanup operations through the maintenance service", async () => {
    const service = new AgentMaintenanceService({
      repository: new DatabaseAgentMaintenanceRepository(testDb.db),
      logger,
    });
    const result = await service.runOnce();
    expect(result.tokens).toBeGreaterThanOrEqual(0);
    expect(result.certificates).toBeGreaterThanOrEqual(0);
    service.stop();
  });
});
