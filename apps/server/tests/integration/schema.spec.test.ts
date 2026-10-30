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

async function foreignKeys(): Promise<Map<string, string[]>> {
  const result = await testDb.db.executeQuery<{
    table_name: string;
    definition: string;
  }>(
    `SELECT conrelid::regclass::text AS table_name,
            pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace
      ORDER BY conrelid::regclass::text, conname`,
  );
  const grouped = new Map<string, string[]>();
  for (const row of result.records) {
    const definitions = grouped.get(row.table_name) ?? [];
    definitions.push(row.definition.replace(/\s+/g, " ").trim());
    grouped.set(row.table_name, definitions);
  }
  return grouped;
}

async function checkConstraints(): Promise<Map<string, string[]>> {
  const result = await testDb.db.executeQuery<{
    table_name: string;
    definition: string;
  }>(
    `SELECT conrelid::regclass::text AS table_name,
            pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE contype = 'c' AND connamespace = 'public'::regnamespace
      ORDER BY conrelid::regclass::text, conname`,
  );
  const grouped = new Map<string, string[]>();
  for (const row of result.records) {
    const definitions = grouped.get(row.table_name) ?? [];
    definitions.push(row.definition.replace(/\s+/g, " ").trim());
    grouped.set(row.table_name, definitions);
  }
  return grouped;
}

describe("schema inventory", () => {
  it("should create the complete table inventory", async () => {
    const result = await testDb.db.executeQuery<{ name: string }>(
      `SELECT table_name AS name
         FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name`,
    );
    expect(result.records.map((row) => row.name)).toEqual([
      "audit_checkpoints",
      "audit_events",
      "audit_keys",
      "blendsdk_migrations",
      "certificate_versions",
      "certificates",
      "cli_sessions",
      "consumers",
      "idempotency_keys",
      "join_tokens",
      "local_credentials",
      "oidc_identities",
      "org",
      "principals",
      "projects",
      "role_assignments",
      "secret_versions",
      "secrets",
      "workload_certs",
    ]);
  });

  it("should create all declared foreign keys with their delete actions", async () => {
    const keys = await foreignKeys();
    expect([...keys.values()].flat()).toHaveLength(24);

    expect(keys.get("principals")).toContain(
      "FOREIGN KEY (owner_project_id) REFERENCES projects(id) ON DELETE RESTRICT",
    );
    expect(keys.get("join_tokens")).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT",
        ),
        expect.stringContaining(
          "FOREIGN KEY (principal_id, project_id) REFERENCES principals(id, owner_project_id) ON DELETE CASCADE",
        ),
      ]),
    );
    expect(keys.get("consumers")).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "FOREIGN KEY (principal_id, project_id) REFERENCES principals(id, owner_project_id) ON DELETE CASCADE",
        ),
      ]),
    );
    expect(keys.get("secret_versions")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("FOREIGN KEY (secret_id) REFERENCES secrets(id) ON DELETE CASCADE"),
      ]),
    );
    expect(keys.get("secrets")).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "FOREIGN KEY (id, current_version_id) REFERENCES secret_versions(secret_id, id) DEFERRABLE INITIALLY DEFERRED",
        ),
      ]),
    );
    expect(keys.get("certificates")).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "FOREIGN KEY (id, current_version_id) REFERENCES certificate_versions(certificate_id, id) DEFERRABLE INITIALLY DEFERRED",
        ),
      ]),
    );
  });

  it("should create the unique constraints and partial active-name indexes", async () => {
    const result = await testDb.db.executeQuery<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public' AND indexdef LIKE 'CREATE UNIQUE INDEX%'
        ORDER BY indexname`,
    );
    const names = result.records.map((row) => row.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "audit_checkpoints_last_event_id_key",
        "audit_events_event_id_key",
        "certificate_versions_certificate_id_id_key",
        "certificates_id_current_version_id_key",
        "certificates_name_active_idx",
        "cli_sessions_refresh_hash_key",
        "consumers_principal_id_key",
        "join_tokens_token_hash_key",
        "principals_id_owner_project_id_key",
        "principals_user_email_idx",
        "projects_name_active_idx",
        "role_assignments_principal_id_role_scope_type_scope_id_key",
        "secret_versions_secret_id_id_key",
        "secrets_id_current_version_id_key",
        "secrets_name_active_idx",
        "workload_certs_fingerprint_key",
        "workload_certs_serial_key",
      ]),
    );

    const projectsIndex = result.records.find(
      (row) => row.indexname === "projects_name_active_idx",
    );
    expect(projectsIndex?.indexdef).toContain("WHERE (deleted_at IS NULL)");
  });

  it("should create the domain CHECK constraints", async () => {
    const checks = await checkConstraints();
    const definitions = [...checks.values()].flat().join("\n");

    expect(definitions).toContain("name ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'");
    expect(definitions).toContain("kind = 'service'");
    expect(definitions).toContain("owner_project_id IS NOT NULL");
    expect(definitions).toContain("argon2id");
    expect(definitions).toContain("octet_length(refresh_hash) = 32");
    expect(definitions).toContain("scope_type = 'org'");
    expect(definitions).toContain("scope_id = 'org'");
    expect(definitions).toContain("scope_type <> 'object'");
    expect(definitions).toContain("octet_length(nonce) = 12");
    expect(definitions).toContain("octet_length(tag) = 16");
    expect(definitions).toContain("octet_length(wrapped_dek) = 32");
    expect(definitions).toContain("purge_after IS NULL");
    expect(definitions).toContain("project_id IS NOT NULL");
    expect(definitions).toContain("actor_kind <> 'system'");
    expect(definitions).toContain("octet_length(request_hash) = 32");
  });

  it("should seed exactly one organization row", async () => {
    const result = await testDb.db.executeQuery<{ id: number; count: number }>(
      "SELECT id, count(*)::int AS count FROM org GROUP BY id",
    );
    expect(result.records).toEqual([{ id: 1, count: 1 }]);
  });
});

describe("current-version ownership", () => {
  it("should reject a secret current version that belongs to another secret", async () => {
    const otherSecretId = testUlid(20);
    const otherVersionId = testUlid(21);
    await testDb.db.executeQuery(
      `INSERT INTO secrets (id, project_id, name)
       VALUES (:id, :projectId, 'other-secret')`,
      { id: otherSecretId, projectId: base.projectId },
    );
    await testDb.db.executeQuery(
      `INSERT INTO secret_versions
         (id, secret_id, ciphertext, nonce, tag, wrapped_dek, wrap_nonce, wrap_tag, kek_id, created_by)
       VALUES
         (:id, :secretId, :ciphertext, :nonce, :tag, :wrappedDek, :wrapNonce, :wrapTag, 'kek-1', :createdBy)`,
      {
        id: otherVersionId,
        secretId: otherSecretId,
        ciphertext: Buffer.from("other"),
        nonce: nonce(20),
        tag: tag(20),
        wrappedDek: bytes32(20),
        wrapNonce: nonce(21),
        wrapTag: tag(21),
        createdBy: base.userId,
      },
    );

    await expect(
      testDb.db.executeQuery(
        "UPDATE secrets SET current_version_id = :versionId WHERE id = :secretId",
        { versionId: otherVersionId, secretId: base.secretId },
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("should reject a certificate current version that belongs to another certificate", async () => {
    const otherCertificateId = testUlid(22);
    const otherVersionId = testUlid(23);
    await testDb.db.executeQuery(
      `INSERT INTO certificates (id, project_id, name)
       VALUES (:id, :projectId, 'other-cert')`,
      { id: otherCertificateId, projectId: base.projectId },
    );
    await testDb.db.executeQuery(
      `INSERT INTO certificate_versions
         (id, certificate_id, chain_pem, ciphertext, nonce, tag, wrapped_dek, wrap_nonce,
          wrap_tag, kek_id, fingerprint, subject, issuer, serial, not_before, not_after, created_by)
       VALUES
         (:id, :certificateId, 'chain', :ciphertext, :nonce, :tag, :wrappedDek, :wrapNonce,
          :wrapTag, 'kek-1', 'sha256:other', 'CN=other', 'CN=ca', '02',
          '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', :createdBy)`,
      {
        id: otherVersionId,
        certificateId: otherCertificateId,
        ciphertext: Buffer.from("other-cert"),
        nonce: nonce(22),
        tag: tag(22),
        wrappedDek: bytes32(22),
        wrapNonce: nonce(23),
        wrapTag: tag(23),
        createdBy: base.userId,
      },
    );

    await expect(
      testDb.db.executeQuery(
        "UPDATE certificates SET current_version_id = :versionId WHERE id = :certificateId",
        { versionId: otherVersionId, certificateId: base.certificateId },
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});

describe("envelope and audit constraints", () => {
  it("should reject invalid secret envelope lengths and oversized ciphertext", async () => {
    const invalidValues = [
      {
        nonce: Buffer.alloc(11),
        tag: tag(30),
        wrappedDek: bytes32(30),
        ciphertext: Buffer.from("x"),
      },
      {
        nonce: nonce(30),
        tag: Buffer.alloc(15),
        wrappedDek: bytes32(30),
        ciphertext: Buffer.from("x"),
      },
      {
        nonce: nonce(30),
        tag: tag(30),
        wrappedDek: Buffer.alloc(31),
        ciphertext: Buffer.from("x"),
      },
      { nonce: nonce(30), tag: tag(30), wrappedDek: bytes32(30), ciphertext: Buffer.alloc(65_537) },
    ];

    for (const [index, values] of invalidValues.entries()) {
      await expect(
        testDb.db.executeQuery(
          `INSERT INTO secret_versions
             (id, secret_id, ciphertext, nonce, tag, wrapped_dek, wrap_nonce, wrap_tag, kek_id, created_by)
           VALUES
             (:id, :secretId, :ciphertext, :nonce, :tag, :wrappedDek, :wrapNonce, :wrapTag, 'kek-1', :createdBy)`,
          {
            id: testUlid(30 + index),
            secretId: base.secretId,
            ciphertext: values.ciphertext,
            nonce: values.nonce,
            tag: values.tag,
            wrappedDek: values.wrappedDek,
            wrapNonce: nonce(30),
            wrapTag: tag(30),
            createdBy: base.userId,
          },
        ),
      ).rejects.toThrow(/check constraint|violates/i);
    }
  });

  it("should reject invalid audit hashes and unknown audit keys", async () => {
    await expect(
      testDb.db.executeQuery(
        `INSERT INTO audit_events
           (event_id, project_id, request_id, actor_id, actor_kind, action, scope_type, scope_id,
            result, prev_hash, hash, hmac, audit_key_id)
         VALUES
           (:eventId, :projectId, 'req-2', :actorId, 'user', 'test.action', 'project', :projectId,
            'allow', :prevHash, :hash, :hmac, :auditKeyId)`,
        {
          eventId: testUlid(40),
          projectId: base.projectId,
          actorId: base.userId,
          prevHash: bytes32(40),
          hash: Buffer.alloc(31),
          hmac: bytes32(40),
          auditKeyId: base.auditKeyId,
        },
      ),
    ).rejects.toThrow(/check constraint|violates/i);

    await expect(
      testDb.db.executeQuery(
        `INSERT INTO audit_events
           (event_id, project_id, request_id, actor_kind, action, scope_type, scope_id,
            result, prev_hash, hash, hmac, audit_key_id)
         VALUES
           (:eventId, :projectId, 'req-3', 'system', 'test.action', 'project', :projectId,
            'allow', :prevHash, :hash, :hmac, :auditKeyId)`,
        {
          eventId: testUlid(41),
          projectId: base.projectId,
          prevHash: bytes32(41),
          hash: bytes32(41),
          hmac: bytes32(41),
          auditKeyId: testUlid(42),
        },
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("should reject updates and deletes on audit rows", async () => {
    const event = await testDb.db.executeQuery<{ id: string }>(
      "SELECT id FROM audit_events WHERE event_id = :eventId",
      { eventId: base.auditEventId },
    );
    const eventRowId = event.records[0]?.id;
    expect(eventRowId).toBeDefined();

    await expect(
      testDb.db.executeQuery("UPDATE audit_events SET action = 'changed' WHERE id = :id", {
        id: eventRowId,
      }),
    ).rejects.toThrow(/append-only/i);
    await expect(
      testDb.db.executeQuery("DELETE FROM audit_events WHERE id = :id", { id: eventRowId }),
    ).rejects.toThrow(/append-only/i);

    const checkpoint = await testDb.db.executeQuery<{ id: string }>(
      "SELECT id FROM audit_checkpoints LIMIT 1",
    );
    const checkpointId = checkpoint.records[0]?.id;
    expect(checkpointId).toBeDefined();
    await expect(
      testDb.db.executeQuery("UPDATE audit_checkpoints SET last_hash = :hash WHERE id = :id", {
        id: checkpointId,
        hash: bytes32(43),
      }),
    ).rejects.toThrow(/append-only/i);
    await expect(
      testDb.db.executeQuery("DELETE FROM audit_checkpoints WHERE id = :id", { id: checkpointId }),
    ).rejects.toThrow(/append-only/i);

    await expect(
      testDb.db.withTransaction(async (tx) => {
        await tx.executeQuery("SET LOCAL openvault.allow_audit_prune = 'on'");
        await tx.executeQuery("DELETE FROM audit_events WHERE id = :id", { id: eventRowId });
      }),
    ).rejects.toThrow(/append-only/i);

    await expect(testDb.db.executeQuery("TRUNCATE audit_events")).rejects.toThrow(
      /TRUNCATE is not allowed/i,
    );
  });
});

describe("version protection", () => {
  it("should reject direct updates to secret and certificate versions", async () => {
    await expect(
      testDb.db.executeQuery("UPDATE secret_versions SET ciphertext = :ciphertext WHERE id = :id", {
        id: base.secretVersionId,
        ciphertext: Buffer.from("changed"),
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      testDb.db.executeQuery(
        "UPDATE certificate_versions SET ciphertext = :ciphertext WHERE id = :id",
        { id: base.certificateVersionId, ciphertext: Buffer.from("changed") },
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it("should reject direct deletes without the purge role", async () => {
    await expect(
      testDb.db.executeQuery("DELETE FROM secret_versions WHERE id = :id", {
        id: base.secretVersionId,
      }),
    ).rejects.toThrow(/purge role/i);
    await expect(testDb.db.executeQuery("TRUNCATE secrets CASCADE")).rejects.toThrow(
      /TRUNCATE is not allowed/i,
    );
  });

  it("should reject disabling purge protection", async () => {
    const secretId = testUlid(50);
    await testDb.db.executeQuery(
      `INSERT INTO secrets (id, project_id, name, purge_protected)
       VALUES (:id, :projectId, 'protected-secret', true)`,
      { id: secretId, projectId: base.projectId },
    );

    await expect(
      testDb.db.executeQuery("UPDATE secrets SET purge_protected = false WHERE id = :id", {
        id: secretId,
      }),
    ).rejects.toThrow(/purge protection cannot be disabled/i);
    await expect(
      testDb.db.executeQuery("DELETE FROM secrets WHERE id = :id", { id: secretId }),
    ).rejects.toThrow(/purge role/i);
  });
});

describe("RBAC and ownership", () => {
  it("should reject unsupported object-scope writer roles", async () => {
    for (const [index, role] of ["org.admin", "secrets.manager"].entries()) {
      await expect(
        testDb.db.executeQuery(
          `INSERT INTO role_assignments
             (id, principal_id, role, scope_type, scope_id, granted_by)
           VALUES (:id, :principalId, :role, 'object', :scopeId, :grantedBy)`,
          {
            id: testUlid(60 + index),
            principalId: base.serviceId,
            role,
            scopeId: testUlid(62),
            grantedBy: base.userId,
          },
        ),
      ).rejects.toThrow(/check constraint|violates/i);
    }

    await expect(
      testDb.db.executeQuery(
        `INSERT INTO role_assignments
           (id, principal_id, role, scope_type, scope_id, granted_by)
         VALUES (:id, :principalId, 'secrets.reader', 'object', :scopeId, :grantedBy)`,
        {
          id: testUlid(63),
          principalId: base.serviceId,
          scopeId: testUlid(64),
          grantedBy: base.userId,
        },
      ),
    ).resolves.toBeDefined();
  });

  it("should reject join tokens and consumers bound to another project", async () => {
    const otherProjectId = testUlid(70);
    await testDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, 'other-project')", {
      id: otherProjectId,
    });

    await expect(
      testDb.db.executeQuery(
        `INSERT INTO join_tokens
           (id, token_hash, principal_id, project_id, expires_at, created_by)
         VALUES (:id, :tokenHash, :principalId, :projectId, :expiresAt, :createdBy)`,
        {
          id: testUlid(71),
          tokenHash: bytes32(71),
          principalId: base.serviceId,
          projectId: otherProjectId,
          expiresAt: "2027-01-01T00:00:00Z",
          createdBy: base.userId,
        },
      ),
    ).rejects.toThrow(/foreign key|violates/i);

    await expect(
      testDb.db.executeQuery(
        `INSERT INTO consumers
           (id, principal_id, project_id, compose_project, compose_service, hostname, manifest_hash)
         VALUES
           (:id, :principalId, :projectId, 'compose', 'service', 'service.local', :manifestHash)`,
        {
          id: testUlid(72),
          principalId: base.serviceId,
          projectId: otherProjectId,
          manifestHash: `sha256:${"a".repeat(64)}`,
        },
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("should reject a service principal without an owner project", async () => {
    await expect(
      testDb.db.executeQuery(
        `INSERT INTO principals (id, kind, name)
         VALUES (:id, 'service', 'unowned-service')`,
        { id: testUlid(80) },
      ),
    ).rejects.toThrow(/check constraint|violates/i);
  });
});
