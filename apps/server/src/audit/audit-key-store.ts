import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { newUlid } from "@openvault/core";
import type { KeyringProvider } from "../security/keyring.js";
import { AuditKeyUnavailableError } from "./errors.js";
import type { AuditQueryExecutor } from "./types.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** One row from `audit_keys`. */
export interface AuditKeyRow {
  /** Key row identifier. */
  readonly id: string;
  /** AES-256-GCM ciphertext of the audit key. */
  readonly wrappedKey: Buffer;
  /** GCM nonce used to wrap the audit key. */
  readonly wrapNonce: Buffer;
  /** GCM authentication tag for the wrapped key. */
  readonly wrapTag: Buffer;
  /** KEK that wrapped the key. */
  readonly kekId: string;
}

interface AuditKeyDatabaseRow {
  readonly id: string;
  readonly wrapped_key: Buffer;
  readonly wrap_nonce: Buffer;
  readonly wrap_tag: Buffer;
  readonly kek_id: string;
}

/** Builds the additional authenticated data bound to one audit key row. */
function keyAad(id: string, kekId: string): Buffer {
  return Buffer.from(`ov:audit-key:v1:${id}:${kekId}`, "utf8");
}

/** Maps one database row to the public key shape. */
function toKeyRow(row: AuditKeyDatabaseRow): AuditKeyRow {
  return {
    id: row.id,
    wrappedKey: row.wrapped_key,
    wrapNonce: row.wrap_nonce,
    wrapTag: row.wrap_tag,
    kekId: row.kek_id,
  };
}

/**
 * Returns the existing audit key, creating it under the caller's chain lock.
 *
 * The caller must already hold the audit chain advisory lock, so two writers
 * cannot create competing keys.
 *
 * @param tx - Transaction that already holds the chain lock.
 * @param keyring - Loaded KEK provider.
 * @param now - Timestamp for the created row.
 * @returns The existing or newly created key.
 * @throws {AuditKeyUnavailableError} When no current KEK is loaded.
 */
export async function selectOrCreateAuditKey(
  tx: AuditQueryExecutor,
  keyring: KeyringProvider,
  now: Date,
): Promise<AuditKeyRow> {
  const existing = await tx.executeQuery<AuditKeyDatabaseRow>(
    `SELECT id, wrapped_key, wrap_nonce, wrap_tag, kek_id
       FROM audit_keys
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
  );
  const row = existing.records[0];
  if (row !== undefined) {
    return toKeyRow(row);
  }

  const kekId = keyring.currentId;
  if (kekId === undefined) {
    throw new AuditKeyUnavailableError();
  }

  const id = newUlid();
  const auditKey = randomBytes(KEY_BYTES);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const wrapped = keyring.withCurrentKey((key) => {
      const encryptor = createCipheriv(ALGORITHM, key, nonce);
      encryptor.setAAD(keyAad(id, kekId));
      return Buffer.concat([encryptor.update(auditKey), encryptor.final(), encryptor.getAuthTag()]);
    });

    const wrappedKey = wrapped.subarray(0, KEY_BYTES);
    const wrapTag = wrapped.subarray(KEY_BYTES);

    await tx.executeQuery(
      `INSERT INTO audit_keys (id, wrapped_key, wrap_nonce, wrap_tag, kek_id, created_at)
       VALUES (:id, :wrappedKey, :wrapNonce, :wrapTag, :kekId, :createdAt)`,
      {
        id,
        wrappedKey,
        wrapNonce: nonce,
        wrapTag,
        kekId,
        createdAt: now,
      },
    );

    return { id, wrappedKey, wrapNonce: nonce, wrapTag, kekId };
  } finally {
    auditKey.fill(0);
  }
}

/** Loads one audit key row by id, or undefined. */
export async function loadAuditKey(
  tx: AuditQueryExecutor,
  id: string,
): Promise<AuditKeyRow | undefined> {
  const result = await tx.executeQuery<AuditKeyDatabaseRow>(
    `SELECT id, wrapped_key, wrap_nonce, wrap_tag, kek_id
       FROM audit_keys
      WHERE id = :id`,
    { id },
  );
  const row = result.records[0];
  return row === undefined ? undefined : toKeyRow(row);
}

/**
 * Unwraps one audit key. The caller must zero the returned buffer.
 *
 * @param keyring - Loaded KEK provider.
 * @param row - Persisted key row.
 * @returns The 32-byte audit key.
 * @throws {AuditKeyUnavailableError} When the KEK is missing, the tag fails, or
 *   the recovered key has the wrong length.
 */
export function unwrapAuditKey(keyring: KeyringProvider, row: AuditKeyRow): Buffer {
  try {
    const key = keyring.withKey(row.kekId, (kek) => {
      if (row.wrappedKey.length !== KEY_BYTES) {
        throw new AuditKeyUnavailableError();
      }
      if (row.wrapNonce.length !== NONCE_BYTES || row.wrapTag.length !== TAG_BYTES) {
        throw new AuditKeyUnavailableError();
      }
      const decipher = createDecipheriv(ALGORITHM, kek, row.wrapNonce);
      decipher.setAAD(keyAad(row.id, row.kekId));
      decipher.setAuthTag(row.wrapTag);
      return Buffer.concat([decipher.update(row.wrappedKey), decipher.final()]);
    });
    if (key.length !== KEY_BYTES) {
      key.fill(0);
      throw new AuditKeyUnavailableError();
    }
    return key;
  } catch (error) {
    if (error instanceof AuditKeyUnavailableError) {
      throw error;
    }
    throw new AuditKeyUnavailableError();
  }
}

/**
 * Runs an action with an unwrapped key and zeroes the buffer afterwards.
 *
 * @param keyring - Loaded KEK provider.
 * @param row - Persisted key row.
 * @param action - Synchronous operation that needs the key.
 * @returns The action result.
 * @throws {AuditKeyUnavailableError} When the key cannot be unwrapped.
 */
export function withAuditKey<T>(
  keyring: KeyringProvider,
  row: AuditKeyRow,
  action: (key: Readonly<Buffer>) => T,
): T {
  const key = unwrapAuditKey(keyring, row);
  try {
    return action(key);
  } finally {
    key.fill(0);
  }
}
