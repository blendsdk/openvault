import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { Keyring } from "@openvault/core";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { parseDatabaseUrl } from "../db/url.js";
import { withInitLock } from "../init/lock.js";
import { KeyringProvider } from "../security/keyring.js";
import { recordOperationsEvent } from "./audit.js";
import { openDatabaseClient } from "./database-dump.js";
import { OpsError } from "./errors.js";
import { ensurePrivateDirectory, readBoundedRegularFile, writePrivateFileAtomic } from "./files.js";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

/** Options for one KEK rotation. */
export interface KekRotateOptions {
  /** Application database URL. */
  readonly databaseUrl: string;
  /** Absolute 0600 keyring path. */
  readonly keyringPath: string;
  /** Report counts without changing the keyring or rows. */
  readonly dryRun?: boolean;
  /** Injectable clock. */
  readonly now?: () => number;
}

/** One table's rewrapped row count. */
export interface KekRotateCounts {
  readonly secretVersions: number;
  readonly certificateVersions: number;
  readonly auditKeys: number;
  readonly caKeys: number;
  readonly signingKeys: number;
}

/** Result of one rotation. */
export interface KekRotateResult {
  /** Previous current KEK. */
  readonly oldKekId: string;
  /** New current KEK. */
  readonly newKekId: string;
  /** Rows rewrapped per table. */
  readonly counts: KekRotateCounts;
  /** True when no change was made. */
  readonly dryRun: boolean;
  /** True when the old key was removed from the keyring. */
  readonly oldKeyRemoved: boolean;
}

/** Chooses the next `kek-<n>` identifier. */
function nextKekId(ids: readonly string[]): string {
  const used = new Set(ids);
  let index = 1;
  while (used.has(`kek-${index}`)) {
    index += 1;
  }
  return `kek-${index}`;
}

/** Rewraps one key and returns all three fields. */
function rewrapKeyComplete(input: {
  readonly provider: KeyringProvider;
  readonly oldKekId: string;
  readonly newKekId: string;
  readonly oldAad: Buffer;
  readonly newAad: Buffer;
  readonly wrappedKey: Buffer;
  readonly wrapNonce: Buffer;
  readonly wrapTag: Buffer;
}): { readonly wrappedKey: Buffer; readonly wrapNonce: Buffer; readonly wrapTag: Buffer } {
  if (
    input.wrappedKey.length !== KEY_BYTES ||
    input.wrapNonce.length !== NONCE_BYTES ||
    input.wrapTag.length !== TAG_BYTES
  ) {
    throw new OpsError("kek_rotation_failed", "A wrapped key has invalid lengths");
  }
  let plaintext: Buffer | undefined;
  try {
    plaintext = input.provider.withKey(input.oldKekId, (oldKey) => {
      const decipher = createDecipheriv(ALGORITHM, oldKey, input.wrapNonce);
      decipher.setAAD(input.oldAad);
      decipher.setAuthTag(input.wrapTag);
      return Buffer.concat([decipher.update(input.wrappedKey), decipher.final()]);
    });
    if (plaintext.length !== KEY_BYTES) {
      throw new OpsError("kek_rotation_failed", "An unwrapped key has the wrong length");
    }
    const wrapNonce = randomBytes(NONCE_BYTES);
    return input.provider.withKey(input.newKekId, (newKey) => {
      const cipher = createCipheriv(ALGORITHM, newKey, wrapNonce);
      cipher.setAAD(input.newAad);
      const wrappedKey = Buffer.concat([
        cipher.update(plaintext ?? Buffer.alloc(0)),
        cipher.final(),
      ]);
      return { wrappedKey, wrapNonce, wrapTag: cipher.getAuthTag() };
    });
  } finally {
    plaintext?.fill(0);
  }
}

/** Builds the secret/certificate wrap AAD. */
function envelopeAad(
  kekId: string,
  objectType: "secret" | "certificate",
  projectId: string,
  objectId: string,
  version: string,
): Buffer {
  return Buffer.from(
    `ov:dek:v2:${kekId}:${objectType}:${projectId}:${objectId}:${version}`,
    "utf8",
  );
}

/** Builds the audit-key wrap AAD. */
function auditAad(id: string, kekId: string): Buffer {
  return Buffer.from(`ov:audit-key:v1:${id}:${kekId}`, "utf8");
}

/** Builds the CA wrap AAD. */
function caAad(id: string): Buffer {
  return Buffer.from(`ov:ca:v1:${id}`, "utf8");
}

/** Builds the JWT seed wrap AAD. */
function jwtAad(kid: string): Buffer {
  return Buffer.from(`ov:jwt:v1:${kid}`, "utf8");
}

/** Counts rows that would be rewrapped to the new KEK. */
async function countRotationCandidates(
  database: PostgreSQLDatabase,
  newKekId: string,
): Promise<KekRotateCounts> {
  const counts = await database.executeQuery<{
    readonly secret_versions: string;
    readonly certificate_versions: string;
    readonly audit_keys: string;
    readonly ca_keys: string;
    readonly signing_keys: string;
  }>(
    `SELECT
       (SELECT count(*) FROM secret_versions WHERE kek_id <> CAST(:newKekId AS text))::text AS secret_versions,
       (SELECT count(*) FROM certificate_versions WHERE kek_id <> CAST(:newKekId AS text))::text AS certificate_versions,
       (SELECT count(*) FROM audit_keys WHERE kek_id <> CAST(:newKekId AS text))::text AS audit_keys,
       (SELECT count(*) FROM ca_keys WHERE kek_id <> CAST(:newKekId AS text))::text AS ca_keys,
       (SELECT count(*) FROM signing_keys WHERE kek_id <> CAST(:newKekId AS text))::text AS signing_keys`,
    { newKekId },
  );
  const row = counts.records[0];
  return {
    secretVersions: Number(row?.secret_versions ?? "0"),
    certificateVersions: Number(row?.certificate_versions ?? "0"),
    auditKeys: Number(row?.audit_keys ?? "0"),
    caKeys: Number(row?.ca_keys ?? "0"),
    signingKeys: Number(row?.signing_keys ?? "0"),
  };
}

/**
 * Rotates the current KEK and rewraps every stored key.
 *
 * Values are never re-encrypted. The new key is published in the keyring
 * before rows move, so a crash leaves both keys available. The old key is
 * removed only after every `kek_id` has been verified.
 *
 * @param options - Database, keyring, and dry-run policy.
 * @returns Rotation counts.
 */
async function runKekRotateLocked(options: KekRotateOptions): Promise<KekRotateResult> {
  const raw = readBoundedRegularFile(options.keyringPath, 1_048_576, 0o600);
  let document: { version: 1; current: string; keys: Record<string, string> };
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    const validated = Keyring.fromJSON(parsed);
    validated.destroy();
    document = parsed as { version: 1; current: string; keys: Record<string, string> };
  } catch (error) {
    throw new OpsError("kek_rotation_failed", "The keyring is invalid", { cause: error });
  }
  const oldKekId = document.current;
  const referenced = new Set<string>();
  const probe = await openDatabaseClient(options.databaseUrl);
  try {
    const result = await probe.query<{ kek_id: string }>(
      `SELECT DISTINCT kek_id FROM (
         SELECT kek_id FROM secret_versions
         UNION SELECT kek_id FROM certificate_versions
         UNION SELECT kek_id FROM audit_keys
         UNION SELECT kek_id FROM ca_keys
         UNION SELECT kek_id FROM signing_keys
       ) AS keys`,
    );
    for (const row of result.rows) {
      referenced.add(row.kek_id);
      if (!Object.hasOwn(document.keys, row.kek_id)) {
        throw new OpsError(
          "kek_rotation_failed",
          "A database key is missing from the keyring; restore the keyring before rotating",
        );
      }
    }
  } finally {
    await probe.end();
  }
  const newKekId = nextKekId([...Object.keys(document.keys), ...referenced]);
  const database = new PostgreSQLDatabase({
    ...parseDatabaseUrl(options.databaseUrl),
    poolConfig: { connectionTimeoutMillis: 2_000 },
    enableGracefulShutdown: false,
  });
  if (options.dryRun === true) {
    try {
      return {
        oldKekId,
        newKekId,
        counts: await countRotationCandidates(database, newKekId),
        dryRun: true,
        oldKeyRemoved: false,
      };
    } finally {
      await database.disconnect();
    }
  }

  let oldProvider: KeyringProvider | undefined;
  let newProvider: KeyringProvider | undefined;
  try {
    oldProvider = await KeyringProvider.load(options.keyringPath);
    await recordOperationsEvent({
      database,
      keyring: oldProvider,
      action: "kek.rotate",
      result: "allow",
      details: { kekId: newKekId, phase: "start" },
      ...(options.now === undefined ? {} : { now: options.now }),
      requestId: "kek-rotate",
    });

    const newKey = randomBytes(KEY_BYTES).toString("base64");
    const updated = {
      version: 1,
      current: newKekId,
      keys: { ...document.keys, [newKekId]: newKey },
    };
    writePrivateFileAtomic(
      options.keyringPath,
      Buffer.from(JSON.stringify(updated), "utf8"),
      0o600,
    );
    newProvider = await KeyringProvider.load(options.keyringPath);
    const provider = newProvider;
    if (provider === undefined) {
      throw new OpsError("kek_rotation_failed", "The rotated keyring could not be loaded");
    }

    const counts: KekRotateCounts = await database.withTransaction(async (tx) => {
      const protectedTables = [
        "secret_versions",
        "certificate_versions",
        "audit_keys",
        "ca_keys",
        "signing_keys",
      ];
      try {
        for (const table of protectedTables) {
          await tx.executeQuery(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
        }
      } catch (error) {
        throw new OpsError(
          "kek_rotation_requires_owner",
          "KEK rotation must run as a role that owns the key tables",
          { cause: error },
        );
      }
      let secretVersions = 0;
      const secrets = await tx.executeQuery<{
        readonly id: string;
        readonly kek_id: string;
        readonly wrapped_dek: Buffer;
        readonly wrap_nonce: Buffer;
        readonly wrap_tag: Buffer;
        readonly project_id: string;
        readonly secret_id: string;
      }>(
        `SELECT v.id, v.kek_id, v.wrapped_dek, v.wrap_nonce, v.wrap_tag,
                s.project_id, s.id AS secret_id
           FROM secret_versions v
           JOIN secrets s ON s.id = v.secret_id
          WHERE v.kek_id <> CAST(:newKekId AS text)`,
        { newKekId },
      );
      for (const row of secrets.records) {
        const rewrapped = rewrapKeyComplete({
          provider,
          oldKekId: row.kek_id,
          newKekId,
          oldAad: envelopeAad(row.kek_id, "secret", row.project_id, row.secret_id, row.id),
          newAad: envelopeAad(newKekId, "secret", row.project_id, row.secret_id, row.id),
          wrappedKey: row.wrapped_dek,
          wrapNonce: row.wrap_nonce,
          wrapTag: row.wrap_tag,
        });
        await tx.executeQuery(
          `UPDATE secret_versions
              SET wrapped_dek = :wrappedKey, wrap_nonce = :wrapNonce,
                  wrap_tag = :wrapTag, kek_id = :kekId
            WHERE id = :id`,
          { ...rewrapped, kekId: newKekId, id: row.id },
        );
        secretVersions += 1;
      }

      let certificateVersions = 0;
      const certificates = await tx.executeQuery<{
        readonly id: string;
        readonly kek_id: string;
        readonly wrapped_dek: Buffer;
        readonly wrap_nonce: Buffer;
        readonly wrap_tag: Buffer;
        readonly project_id: string;
        readonly certificate_id: string;
      }>(
        `SELECT v.id, v.kek_id, v.wrapped_dek, v.wrap_nonce, v.wrap_tag,
                c.project_id, c.id AS certificate_id
           FROM certificate_versions v
           JOIN certificates c ON c.id = v.certificate_id
          WHERE v.kek_id <> CAST(:newKekId AS text)`,
        { newKekId },
      );
      for (const row of certificates.records) {
        const rewrapped = rewrapKeyComplete({
          provider,
          oldKekId: row.kek_id,
          newKekId,
          oldAad: envelopeAad(
            row.kek_id,
            "certificate",
            row.project_id,
            row.certificate_id,
            row.id,
          ),
          newAad: envelopeAad(newKekId, "certificate", row.project_id, row.certificate_id, row.id),
          wrappedKey: row.wrapped_dek,
          wrapNonce: row.wrap_nonce,
          wrapTag: row.wrap_tag,
        });
        await tx.executeQuery(
          `UPDATE certificate_versions
              SET wrapped_dek = :wrappedKey, wrap_nonce = :wrapNonce,
                  wrap_tag = :wrapTag, kek_id = :kekId
            WHERE id = :id`,
          { ...rewrapped, kekId: newKekId, id: row.id },
        );
        certificateVersions += 1;
      }

      let auditKeys = 0;
      const audits = await tx.executeQuery<{
        readonly id: string;
        readonly kek_id: string;
        readonly wrapped_key: Buffer;
        readonly wrap_nonce: Buffer;
        readonly wrap_tag: Buffer;
      }>(
        `SELECT id, kek_id, wrapped_key, wrap_nonce, wrap_tag
           FROM audit_keys
          WHERE kek_id <> CAST(:newKekId AS text)`,
        { newKekId },
      );
      for (const row of audits.records) {
        const rewrapped = rewrapKeyComplete({
          provider,
          oldKekId: row.kek_id,
          newKekId,
          oldAad: auditAad(row.id, row.kek_id),
          newAad: auditAad(row.id, newKekId),
          wrappedKey: row.wrapped_key,
          wrapNonce: row.wrap_nonce,
          wrapTag: row.wrap_tag,
        });
        await tx.executeQuery(
          `UPDATE audit_keys
              SET wrapped_key = :wrappedKey, wrap_nonce = :wrapNonce,
                  wrap_tag = :wrapTag, kek_id = :kekId
            WHERE id = :id`,
          { ...rewrapped, kekId: newKekId, id: row.id },
        );
        auditKeys += 1;
      }

      let caKeys = 0;
      const cas = await tx.executeQuery<{
        readonly id: string;
        readonly kek_id: string;
        readonly wrapped_key: Buffer;
        readonly wrap_nonce: Buffer;
        readonly wrap_tag: Buffer;
      }>(
        `SELECT id, kek_id, wrapped_key, wrap_nonce, wrap_tag
           FROM ca_keys
          WHERE kek_id <> CAST(:newKekId AS text)`,
        { newKekId },
      );
      for (const row of cas.records) {
        const rewrapped = rewrapKeyComplete({
          provider,
          oldKekId: row.kek_id,
          newKekId,
          oldAad: caAad(row.id),
          newAad: caAad(row.id),
          wrappedKey: row.wrapped_key,
          wrapNonce: row.wrap_nonce,
          wrapTag: row.wrap_tag,
        });
        await tx.executeQuery(
          `UPDATE ca_keys
              SET wrapped_key = :wrappedKey, wrap_nonce = :wrapNonce,
                  wrap_tag = :wrapTag, kek_id = :kekId
            WHERE id = :id`,
          { ...rewrapped, kekId: newKekId, id: row.id },
        );
        caKeys += 1;
      }

      let signingKeys = 0;
      const signing = await tx.executeQuery<{
        readonly kid: string;
        readonly kek_id: string;
        readonly wrapped_seed: Buffer;
        readonly wrap_nonce: Buffer;
        readonly wrap_tag: Buffer;
      }>(
        `SELECT kid, kek_id, wrapped_seed, wrap_nonce, wrap_tag
           FROM signing_keys
          WHERE kek_id <> CAST(:newKekId AS text)`,
        { newKekId },
      );
      for (const row of signing.records) {
        const rewrapped = rewrapKeyComplete({
          provider,
          oldKekId: row.kek_id,
          newKekId,
          oldAad: jwtAad(row.kid),
          newAad: jwtAad(row.kid),
          wrappedKey: row.wrapped_seed,
          wrapNonce: row.wrap_nonce,
          wrapTag: row.wrap_tag,
        });
        await tx.executeQuery(
          `UPDATE signing_keys
              SET wrapped_seed = :wrappedKey, wrap_nonce = :wrapNonce,
                  wrap_tag = :wrapTag, kek_id = :kekId
            WHERE kid = :kid`,
          { ...rewrapped, kekId: newKekId, kid: row.kid },
        );
        signingKeys += 1;
      }

      for (const table of protectedTables) {
        await tx.executeQuery(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
      }
      return { secretVersions, certificateVersions, auditKeys, caKeys, signingKeys };
    });

    const remaining = await database.executeQuery<{ count: string }>(
      `SELECT (
         (SELECT count(*) FROM secret_versions WHERE kek_id <> CAST(:newKekId AS text)) +
         (SELECT count(*) FROM certificate_versions WHERE kek_id <> CAST(:newKekId AS text)) +
         (SELECT count(*) FROM audit_keys WHERE kek_id <> CAST(:newKekId AS text)) +
         (SELECT count(*) FROM ca_keys WHERE kek_id <> CAST(:newKekId AS text)) +
         (SELECT count(*) FROM signing_keys WHERE kek_id <> CAST(:newKekId AS text))
       )::text AS count`,
      { newKekId },
    );
    if (Number(remaining.records[0]?.count ?? "0") !== 0) {
      throw new OpsError(
        "kek_rotation_incomplete",
        "Some records still reference an old KEK; the old keys were kept",
      );
    }

    const finalDocument = {
      version: 1,
      current: newKekId,
      keys: { [newKekId]: updated.keys[newKekId] },
    };
    writePrivateFileAtomic(
      options.keyringPath,
      Buffer.from(JSON.stringify(finalDocument), "utf8"),
      0o600,
    );
    newProvider.destroy();
    newProvider = await KeyringProvider.load(options.keyringPath);
    await recordOperationsEvent({
      database,
      keyring: newProvider,
      action: "kek.rotate",
      result: "allow",
      details: { kekId: newKekId, phase: "complete" },
      ...(options.now === undefined ? {} : { now: options.now }),
      requestId: "kek-rotate",
    });
    return {
      oldKekId,
      newKekId,
      counts,
      dryRun: false,
      oldKeyRemoved: true,
    };
  } catch (error) {
    const errorProvider = newProvider ?? oldProvider;
    if (errorProvider !== undefined) {
      try {
        await recordOperationsEvent({
          database,
          keyring: errorProvider,
          action: "kek.rotate",
          result: "error",
          details: { kekId: newKekId, phase: "error" },
          ...(options.now === undefined ? {} : { now: options.now }),
          requestId: "kek-rotate",
        });
      } catch {
        // Preserve the original failure.
      }
    }
    if (error instanceof OpsError) {
      throw error;
    }
    throw new OpsError("kek_rotation_failed", "The KEK rotation failed", { cause: error });
  } finally {
    oldProvider?.destroy();
    newProvider?.destroy();
    await database.disconnect();
  }
}

/**
 * Serializes one KEK rotation with a keyring-directory lock.
 *
 * @param options - Database, keyring, and dry-run policy.
 * @returns Rotation counts.
 */
export async function runKekRotate(options: KekRotateOptions): Promise<KekRotateResult> {
  if (options.dryRun === true) {
    return await runKekRotateLocked(options);
  }
  ensurePrivateDirectory(dirname(options.keyringPath));
  return await withInitLock(
    `${options.keyringPath}.rotate.lock`,
    async () => await runKekRotateLocked(options),
  );
}
