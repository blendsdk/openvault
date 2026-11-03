import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BaseFixture, bytes32, nonce, seedBase, tag, testUlid } from "./helpers/fixtures.js";
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

interface CaKeyInsert {
  readonly id?: string;
  readonly certPem?: string;
  readonly publicKey?: Buffer;
  readonly wrappedKey?: Buffer;
  readonly wrapNonce?: Buffer;
  readonly wrapTag?: Buffer;
  readonly kekId?: string;
  readonly status?: string;
  readonly activatedAt?: string;
  readonly retiredAt?: string | null;
}

/** Inserts one CA-key row with valid values unless an override is supplied. */
async function insertCaKey(input: CaKeyInsert = {}): Promise<void> {
  const status = input.status ?? "current";
  const retiredAt =
    input.retiredAt !== undefined
      ? input.retiredAt
      : status === "retired"
        ? "2026-10-30T12:00:00Z"
        : null;

  await testDb.db.executeQuery(
    `INSERT INTO ca_keys
       (id, cert_pem, public_key, wrapped_key, wrap_nonce, wrap_tag, kek_id, status,
        activated_at, retired_at)
     VALUES
       (:id, :certPem, :publicKey, :wrappedKey, :wrapNonce, :wrapTag, :kekId, :status,
        :activatedAt, :retiredAt)`,
    {
      id: input.id ?? testUlid(300),
      certPem: input.certPem ?? "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
      publicKey: input.publicKey ?? Buffer.alloc(65, 1),
      wrappedKey: input.wrappedKey ?? bytes32(30),
      wrapNonce: input.wrapNonce ?? nonce(31),
      wrapTag: input.wrapTag ?? tag(32),
      kekId: input.kekId ?? "kek-1",
      status,
      activatedAt: input.activatedAt ?? "2026-10-30T12:00:00Z",
      retiredAt,
    },
  );
}

describe("CA key schema", () => {
  it("should create the ca_keys table with the documented columns", async () => {
    const result = await testDb.db.executeQuery<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'ca_keys'
        ORDER BY ordinal_position`,
    );

    expect(result.records.map((row) => row.column_name).sort()).toEqual([
      "activated_at",
      "cert_pem",
      "created_at",
      "id",
      "kek_id",
      "public_key",
      "retired_at",
      "status",
      "wrap_nonce",
      "wrap_tag",
      "wrapped_key",
    ]);

    const columns = new Map(result.records.map((row) => [row.column_name, row]));
    expect(columns.get("id")?.data_type).toBe("text");
    expect(columns.get("cert_pem")?.data_type).toBe("text");
    expect(columns.get("public_key")?.data_type).toBe("bytea");
    expect(columns.get("wrapped_key")?.data_type).toBe("bytea");
    expect(columns.get("wrap_nonce")?.data_type).toBe("bytea");
    expect(columns.get("wrap_tag")?.data_type).toBe("bytea");
    expect(columns.get("kek_id")?.data_type).toBe("text");
    expect(columns.get("status")?.data_type).toBe("text");
    expect(columns.get("created_at")?.column_default).toMatch(/now\(\)|CURRENT_TIMESTAMP/i);
    expect(columns.get("activated_at")?.is_nullable).toBe("NO");
    expect(columns.get("retired_at")?.is_nullable).toBe("YES");
  });

  it("should enforce key lengths, status, and retirement consistency", async () => {
    await testDb.db.executeQuery("DELETE FROM ca_keys");
    await insertCaKey({ status: "retired" });

    const invalid: ReadonlyArray<readonly [string, CaKeyInsert]> = [
      ["an empty certificate", { id: testUlid(340), certPem: "" }],
      ["a 16,385-character certificate", { id: testUlid(341), certPem: "a".repeat(16_385) }],
      ["a 64-byte public key", { id: testUlid(342), publicKey: Buffer.alloc(64) }],
      ["a 66-byte public key", { id: testUlid(343), publicKey: Buffer.alloc(66) }],
      ["a 31-byte wrapped key", { id: testUlid(344), wrappedKey: Buffer.alloc(31) }],
      ["a 33-byte wrapped key", { id: testUlid(345), wrappedKey: Buffer.alloc(33) }],
      ["an 11-byte nonce", { id: testUlid(346), wrapNonce: Buffer.alloc(11) }],
      ["a 13-byte nonce", { id: testUlid(347), wrapNonce: Buffer.alloc(13) }],
      ["a 15-byte tag", { id: testUlid(348), wrapTag: Buffer.alloc(15) }],
      ["a 17-byte tag", { id: testUlid(349), wrapTag: Buffer.alloc(17) }],
      ["an empty KEK id", { id: testUlid(350), kekId: "" }],
      ["a 65-character KEK id", { id: testUlid(351), kekId: "k".repeat(65) }],
      ["an unknown status", { id: testUlid(352), status: "active" }],
      [
        "a retired row without retired_at",
        { id: testUlid(353), status: "retired", retiredAt: null },
      ],
      [
        "a current row with retired_at",
        { id: testUlid(354), status: "current", retiredAt: "2026-10-30T12:00:00Z" },
      ],
      ["a non-ULID id", { id: "not-a-ulid" }],
    ];

    for (const [label, input] of invalid) {
      await expect(insertCaKey(input), label).rejects.toThrow(/check constraint/i);
    }

    await testDb.db.executeQuery("DELETE FROM ca_keys");
  });

  it("should allow exactly one current CA key", async () => {
    await testDb.db.executeQuery("DELETE FROM ca_keys");
    await insertCaKey({ id: testUlid(310), status: "current" });
    await insertCaKey({ id: testUlid(311), status: "retired" });

    await expect(insertCaKey({ id: testUlid(312), status: "current" })).rejects.toThrow(
      /duplicate key|unique/i,
    );

    await testDb.db.executeQuery("DELETE FROM ca_keys");
  });
});

describe("workload identity lifecycle schema", () => {
  it("should add join-token revocation and cleanup indexes", async () => {
    const columns = await testDb.db.executeQuery<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'join_tokens'
        ORDER BY ordinal_position`,
    );
    expect(columns.records).toContainEqual({ column_name: "revoked_at", is_nullable: "YES" });

    const indexes = await testDb.db.executeQuery<{ indexname: string; indexdef: string }>(
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
    const definitions = new Map(indexes.records.map((row) => [row.indexname, row.indexdef]));

    expect(definitions.get("ca_keys_current_idx")).toContain("WHERE (status = 'current'::text)");
    expect(definitions.get("join_tokens_expires_idx")).toContain("(expires_at)");
    expect(definitions.get("workload_certs_not_after_idx")).toContain("(not_after)");
    expect(definitions.get("principals_service_name_active_idx")).toContain(
      "WHERE ((kind = 'service'::text) AND (status = 'active'::text))",
    );
  });

  it("should keep active service names unique per project and allow reuse after disable", async () => {
    const name = `service-${testUlid(320).toLowerCase()}`;
    const first = testUlid(321);
    const second = testUlid(322);

    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, owner_project_id)
       VALUES (:id, 'service', :name, :projectId)`,
      { id: first, name, projectId: base.projectId },
    );

    await expect(
      testDb.db.executeQuery(
        `INSERT INTO principals (id, kind, name, owner_project_id)
         VALUES (:id, 'service', :name, :projectId)`,
        { id: second, name, projectId: base.projectId },
      ),
    ).rejects.toThrow(/duplicate key|unique/i);

    await testDb.db.executeQuery(
      `UPDATE principals
          SET status = 'disabled', disabled_at = now()
        WHERE id = :id`,
      { id: first },
    );

    await expect(
      testDb.db.executeQuery(
        `INSERT INTO principals (id, kind, name, owner_project_id)
         VALUES (:id, 'service', :name, :projectId)`,
        { id: second, name, projectId: base.projectId },
      ),
    ).resolves.toBeDefined();

    const secondProject = testUlid(323);
    const otherProjectService = testUlid(324);
    await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, 'other-project')", {
      id: secondProject,
    });
    await expect(
      testDb.db.executeQuery(
        `INSERT INTO principals (id, kind, name, owner_project_id)
         VALUES (:id, 'service', :name, :projectId)`,
        { id: otherProjectService, name, projectId: secondProject },
      ),
    ).resolves.toBeDefined();

    await testDb.db.executeQuery("DELETE FROM principals WHERE id IN (:first, :second, :third)", {
      first,
      second,
      third: otherProjectService,
    });
    await testDb.db.executeQuery("DELETE FROM projects WHERE id = :id", { id: secondProject });
  });

  it("should reject a principal kind change", async () => {
    await expect(
      testDb.db.executeQuery(
        `UPDATE principals
            SET kind = 'service', owner_project_id = :projectId
          WHERE id = :id`,
        { projectId: base.projectId, id: base.userId },
      ),
    ).rejects.toThrow(/principal kind is immutable/i);
  });
});

describe("service principal human-credential guards", () => {
  const hash = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA";

  it("should reject a local credential for a service principal", async () => {
    await expect(
      testDb.db.executeQuery(
        `INSERT INTO local_credentials (principal_id, password_hash)
         VALUES (:principalId, :hash)`,
        { principalId: base.serviceId, hash },
      ),
    ).rejects.toThrow(/service principals cannot have human credentials/i);
  });

  it("should reject an OIDC identity for a service principal", async () => {
    await expect(
      testDb.db.executeQuery(
        `INSERT INTO oidc_identities (principal_id, issuer, subject)
         VALUES (:principalId, :issuer, :subject)`,
        { principalId: base.serviceId, issuer: "https://idp.example.test", subject: "service" },
      ),
    ).rejects.toThrow(/service principals cannot have human credentials/i);
  });

  it("should reject a CLI session for a service principal", async () => {
    await expect(
      testDb.db.executeQuery(
        `INSERT INTO cli_sessions (id, principal_id, refresh_hash, family_id, expires_at)
         VALUES (:id, :principalId, :refreshHash, :familyId, :expiresAt)`,
        {
          id: testUlid(330),
          principalId: base.serviceId,
          refreshHash: bytes32(33),
          familyId: testUlid(331),
          expiresAt: "2027-01-01T00:00:00Z",
        },
      ),
    ).rejects.toThrow(/service principals cannot have human credentials/i);
  });

  it("should still allow a user local credential and a full-row update", async () => {
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
        `UPDATE local_credentials SET password_hash = :hash WHERE principal_id = :id`,
        { id: base.userId, hash },
      ),
    ).resolves.toBeDefined();
    await testDb.db.executeQuery("DELETE FROM local_credentials WHERE principal_id = :id", {
      id: base.userId,
    });
  });
});
