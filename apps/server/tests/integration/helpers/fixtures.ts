import type { PostgreSQLDatabase } from "blendsdk/postgresql";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Builds a deterministic, syntactically valid ULID for test data.
 *
 * The value is not a real timestamp-based identifier. It only needs to satisfy the same
 * alphabet and length rules as production identifiers so constraints behave realistically.
 *
 * @param seed - Positive numeric seed.
 * @returns A 26-character Crockford Base32 identifier.
 */
export function testUlid(seed: number): string {
  if (!Number.isSafeInteger(seed) || seed < 1) {
    throw new Error("testUlid seed must be a positive safe integer");
  }
  let value = BigInt(seed);
  let result = "";
  for (let index = 0; index < 26; index += 1) {
    result = ULID_ALPHABET[Number(value % 32n)] + result;
    value /= 32n;
  }
  return result;
}

/** A 32-byte value suitable for hash and wrapped-key columns. */
export function bytes32(fill = 1): Buffer {
  return Buffer.alloc(32, fill);
}

/** A 12-byte nonce. */
export function nonce(fill = 2): Buffer {
  return Buffer.alloc(12, fill);
}

/** A 16-byte authentication tag. */
export function tag(fill = 3): Buffer {
  return Buffer.alloc(16, fill);
}

/** Identifiers created by {@link seedBase}. */
export interface BaseFixture {
  readonly projectId: string;
  readonly userId: string;
  readonly serviceId: string;
  readonly secretId: string;
  readonly secretVersionId: string;
  readonly certificateId: string;
  readonly certificateVersionId: string;
  readonly auditKeyId: string;
  readonly auditEventId: string;
}

/**
 * Seeds one coherent project, user, service identity, secret, certificate, and audit chain.
 *
 * Tests that need a valid row to violate a single constraint can start from this fixture
 * instead of rebuilding the whole graph.
 *
 * @param db - Connected test database.
 * @returns The inserted identifiers.
 */
export async function seedBase(db: PostgreSQLDatabase): Promise<BaseFixture> {
  const projectId = testUlid(1);
  const userId = testUlid(2);
  const serviceId = testUlid(3);
  const secretId = testUlid(4);
  const secretVersionId = testUlid(5);
  const certificateId = testUlid(6);
  const certificateVersionId = testUlid(7);
  const auditKeyId = testUlid(8);
  const auditEventId = testUlid(9);

  await db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, 'foundation')", {
    id: projectId,
  });
  await db.executeQuery(
    `INSERT INTO principals (id, kind, name, email)
     VALUES (:id, 'user', 'Foundation User', 'user@example.test')`,
    { id: userId },
  );
  await db.executeQuery(
    `INSERT INTO principals (id, kind, name, owner_project_id)
     VALUES (:id, 'service', 'foundation-service', :projectId)`,
    { id: serviceId, projectId },
  );

  await db.executeQuery(
    `INSERT INTO secrets (id, project_id, name)
     VALUES (:id, :projectId, 'database-password')`,
    { id: secretId, projectId },
  );
  await db.executeQuery(
    `INSERT INTO secret_versions
       (id, secret_id, ciphertext, nonce, tag, wrapped_dek, wrap_nonce, wrap_tag, kek_id, created_by)
     VALUES
       (:id, :secretId, :ciphertext, :nonce, :tag, :wrappedDek, :wrapNonce, :wrapTag, 'kek-1', :createdBy)`,
    {
      id: secretVersionId,
      secretId,
      ciphertext: Buffer.from("ciphertext"),
      nonce: nonce(),
      tag: tag(),
      wrappedDek: bytes32(4),
      wrapNonce: nonce(5),
      wrapTag: tag(6),
      createdBy: userId,
    },
  );
  await db.executeQuery("UPDATE secrets SET current_version_id = :versionId WHERE id = :secretId", {
    versionId: secretVersionId,
    secretId,
  });

  await db.executeQuery(
    `INSERT INTO certificates (id, project_id, name)
     VALUES (:id, :projectId, 'service-cert')`,
    { id: certificateId, projectId },
  );
  await db.executeQuery(
    `INSERT INTO certificate_versions
       (id, certificate_id, chain_pem, ciphertext, nonce, tag, wrapped_dek, wrap_nonce,
        wrap_tag, kek_id, fingerprint, subject, issuer, serial, not_before, not_after, created_by)
     VALUES
       (:id, :certificateId, :chainPem, :ciphertext, :nonce, :tag, :wrappedDek, :wrapNonce,
        :wrapTag, 'kek-1', 'sha256:abc', 'CN=service', 'CN=ca', '01',
        :notBefore, :notAfter, :createdBy)`,
    {
      id: certificateVersionId,
      certificateId,
      chainPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
      ciphertext: Buffer.from("certificate-ciphertext"),
      nonce: nonce(7),
      tag: tag(8),
      wrappedDek: bytes32(9),
      wrapNonce: nonce(10),
      wrapTag: tag(11),
      notBefore: "2026-01-01T00:00:00.000Z",
      notAfter: "2027-01-01T00:00:00.000Z",
      createdBy: userId,
    },
  );
  await db.executeQuery(
    "UPDATE certificates SET current_version_id = :versionId WHERE id = :certificateId",
    { versionId: certificateVersionId, certificateId },
  );

  await db.executeQuery(
    `INSERT INTO audit_keys (id, wrapped_key, wrap_nonce, wrap_tag, kek_id)
     VALUES (:id, :wrappedKey, :wrapNonce, :wrapTag, 'kek-1')`,
    {
      id: auditKeyId,
      wrappedKey: bytes32(12),
      wrapNonce: nonce(13),
      wrapTag: tag(14),
    },
  );
  const auditEvent = await db.executeQuery<{ id: string }>(
    `INSERT INTO audit_events
       (event_id, project_id, request_id, actor_id, actor_kind, action, scope_type, scope_id,
        object_type, object_id, result, prev_hash, hash, hmac, audit_key_id)
     VALUES
       (:eventId, :projectId, 'req-1', :actorId, 'user', 'project.create', 'project', :projectId,
        'project', :projectId, 'allow', :prevHash, :hash, :hmac, :auditKeyId)
     RETURNING id`,
    {
      eventId: auditEventId,
      projectId,
      actorId: userId,
      prevHash: bytes32(15),
      hash: bytes32(16),
      hmac: bytes32(17),
      auditKeyId,
    },
  );
  const auditEventRowId = auditEvent.records[0]?.id;
  if (!auditEventRowId) {
    throw new Error("Audit event insert did not return an id");
  }
  await db.executeQuery(
    `INSERT INTO audit_checkpoints (last_event_id, last_hash, hmac, audit_key_id)
     VALUES (:lastEventId, :lastHash, :hmac, :auditKeyId)`,
    {
      lastEventId: auditEventRowId,
      lastHash: bytes32(18),
      hmac: bytes32(19),
      auditKeyId,
    },
  );

  return {
    projectId,
    userId,
    serviceId,
    secretId,
    secretVersionId,
    certificateId,
    certificateVersionId,
    auditKeyId,
    auditEventId,
  };
}
