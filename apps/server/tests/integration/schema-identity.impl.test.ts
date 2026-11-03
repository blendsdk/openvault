import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CaKeys, eCaKeys } from "../../src/database/index.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
let base: BaseFixture;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("service identity generated artifacts", () => {
  it("should expose the ca_keys table constants and row type", () => {
    expect(eCaKeys.$TABLE).toBe("ca_keys");
    expect(eCaKeys.ID).toBe("id");
    expect(eCaKeys.PUBLIC_KEY).toBe("public_key");
    expect(eCaKeys.WRAPPED_KEY).toBe("wrapped_key");
    expect(eCaKeys.STATUS).toBe("status");

    const row: CaKeys = {
      activated_at: new Date(),
      cert_pem: "certificate",
      created_at: new Date(),
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      kek_id: "kek-1",
      public_key: Buffer.alloc(65),
      retired_at: null,
      status: "current",
      wrap_nonce: Buffer.alloc(12),
      wrap_tag: Buffer.alloc(16),
      wrapped_key: Buffer.alloc(32),
    };
    expect(row.status).toBe("current");
  });

  it("should record both service identity migrations in the ledger", async () => {
    const result = await testDb.db.executeQuery<{ id: string }>(
      "SELECT id FROM blendsdk_migrations ORDER BY id",
    );
    const ids = result.records.map((row) => row.id);
    expect(ids).toContain("20261103141309_service-identities");
    expect(ids).toContain("20261103141310_identity-guards");
    expect(ids).toHaveLength(5);
  });
});

describe("service identity database internals", () => {
  it("should install the identity guard functions and triggers", async () => {
    const functions = await testDb.db.executeQuery<{ proname: string }>(
      `SELECT proname
         FROM pg_proc
        WHERE proname IN ('reject_service_human_credential', 'reject_principal_kind_change')
        ORDER BY proname`,
    );
    expect(functions.records.map((row) => row.proname)).toEqual([
      "reject_principal_kind_change",
      "reject_service_human_credential",
    ]);

    const triggers = await testDb.db.executeQuery<{ tgname: string }>(
      `SELECT tgname
         FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgrelid IN (
            'principals'::regclass,
            'local_credentials'::regclass,
            'oidc_identities'::regclass,
            'cli_sessions'::regclass
          )
        ORDER BY tgname`,
    );
    expect(triggers.records.map((row) => row.tgname)).toEqual(
      expect.arrayContaining([
        "cli_sessions_service_guard",
        "local_credentials_service_guard",
        "oidc_identities_service_guard",
        "principals_kind_immutable",
      ]),
    );
  });

  it("should use the documented index predicates", async () => {
    const result = await testDb.db.executeQuery<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'ca_keys_current_idx',
            'join_tokens_expires_idx',
            'workload_certs_not_after_idx',
            'principals_service_name_active_idx'
          )
        ORDER BY indexname`,
    );
    const indexes = new Map(result.records.map((row) => [row.indexname, row.indexdef]));

    expect(indexes.get("ca_keys_current_idx")).toContain("CREATE UNIQUE INDEX");
    expect(indexes.get("ca_keys_current_idx")).toContain("WHERE (status = 'current'::text)");
    expect(indexes.get("join_tokens_expires_idx")).toContain("(expires_at)");
    expect(indexes.get("join_tokens_expires_idx")).not.toContain("CREATE UNIQUE INDEX");
    expect(indexes.get("workload_certs_not_after_idx")).toContain("(not_after)");
    expect(indexes.get("principals_service_name_active_idx")).toContain("CREATE UNIQUE INDEX");
    expect(indexes.get("principals_service_name_active_idx")).toContain(
      "WHERE ((kind = 'service'::text) AND (status = 'active'::text))",
    );
  });

  it("should allow a full-row user credential update and reject the service path", async () => {
    const hash = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA";
    await testDb.db.executeQuery("DELETE FROM local_credentials WHERE principal_id = :id", {
      id: base.userId,
    });
    await testDb.db.executeQuery(
      `INSERT INTO local_credentials (principal_id, password_hash)
       VALUES (:principalId, :hash)`,
      { principalId: base.userId, hash },
    );

    await expect(
      testDb.db.executeQuery(
        `UPDATE local_credentials
            SET password_hash = :hash, must_change = false
          WHERE principal_id = :id`,
        { id: base.userId, hash },
      ),
    ).resolves.toBeDefined();

    await expect(
      testDb.db.executeQuery(
        `INSERT INTO local_credentials (principal_id, password_hash)
         VALUES (:principalId, :hash)`,
        { principalId: base.serviceId, hash },
      ),
    ).rejects.toThrow(/service principals cannot have human credentials/i);

    await testDb.db.executeQuery("DELETE FROM local_credentials WHERE principal_id = :id", {
      id: base.userId,
    });
  });
});
