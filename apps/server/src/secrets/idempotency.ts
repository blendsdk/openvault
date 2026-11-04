import { createHmac, hkdfSync } from "node:crypto";
import type { EnvelopeKeyring } from "@openvault/core";
import { KeyringError } from "@openvault/core";
import { canonicalJson } from "../audit/canonical-json.js";
import type { AuditQueryExecutor } from "../audit/types.js";
import { SecretServiceError } from "./errors.js";

/** Idempotency window. */
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60_000;

const KEY_PATTERN = /^[\x21-\x7E]{1,200}$/;
const KEYRING_INFO = "openvault:idempotency:v1";

/** One requested claim. */
export interface IdempotencyClaim {
  /** Authenticated principal. */
  readonly principalId: string;
  /** Caller key. */
  readonly key: string;
  /** HTTP method. */
  readonly method: "POST" | "PUT";
  /** Route path. */
  readonly path: string;
  /** Request hash. */
  readonly requestHash: Buffer;
  /** Response status stored on the claim. */
  readonly status: number;
  /** Written version id. */
  readonly versionId: string;
  /** Claim creation time. */
  readonly now: Date;
}

/** Result of claiming one key. */
export type ClaimResult =
  | { readonly kind: "claimed" }
  | { readonly kind: "replay"; readonly versionId: string }
  | { readonly kind: "conflict" };

/**
 * Validates one caller-supplied idempotency key.
 *
 * @param key - Header value.
 * @returns The accepted key.
 * @throws {SecretServiceError} 422 when the key is missing or malformed.
 */
export function validateIdempotencyKey(key: string | undefined): string | undefined {
  if (key === undefined) {
    return undefined;
  }
  if (!KEY_PATTERN.test(key)) {
    throw new SecretServiceError(422, "validation_error", "Validation failed");
  }
  return key;
}

/**
 * Derives the idempotency MAC key from the current KEK.
 *
 * @param keyring - Loaded keyring.
 * @returns A 32-byte derived key; the caller must zero it.
 */
function deriveIdempotencyKey(keyring: EnvelopeKeyring): Buffer {
  if (keyring.currentId === undefined) {
    throw new SecretServiceError(503, "service_unavailable", "Service unavailable");
  }
  try {
    return keyring.withCurrentKey((kek) =>
      Buffer.from(hkdfSync("sha256", kek, Buffer.alloc(0), KEYRING_INFO, 32)),
    );
  } catch (error) {
    if (error instanceof KeyringError) {
      throw new SecretServiceError(503, "service_unavailable", "Service unavailable");
    }
    throw error;
  }
}

/**
 * Computes the keyed request hash for one write.
 *
 * @param keyring - Loaded keyring.
 * @param payload - Method, path, and body.
 * @returns A 32-byte HMAC.
 */
export function requestHash(
  keyring: EnvelopeKeyring,
  payload: { readonly method: string; readonly path: string; readonly body: unknown },
): Buffer {
  const key = deriveIdempotencyKey(keyring);
  try {
    return createHmac("sha256", key).update(canonicalJson(payload), "utf8").digest();
  } finally {
    key.fill(0);
  }
}

interface ClaimRow {
  readonly method: string;
  readonly path: string;
  readonly request_hash: Buffer;
  readonly expires_at: Date;
  readonly resource_id: string | null;
}

/**
 * Claims one idempotency key inside the caller transaction.
 *
 * @param tx - Transaction that also writes the version and decision.
 * @param claim - Claim values.
 * @param now - Service clock in milliseconds.
 * @returns Claimed, replay, or conflict.
 */
export async function claimIdempotency(
  tx: AuditQueryExecutor,
  claim: IdempotencyClaim,
  now: number,
): Promise<ClaimResult> {
  const expiresAt = new Date(now + IDEMPOTENCY_WINDOW_MS);
  const inserted = await tx.executeQuery<{ principal_id: string }>(
    `INSERT INTO idempotency_keys
       (principal_id, key, method, path, request_hash, status, resource_id, expires_at, created_at)
     VALUES
       (:principalId, :key, :method, :path, :requestHash, :status, :versionId, :expiresAt, :now)
     ON CONFLICT (principal_id, key) DO NOTHING
     RETURNING principal_id`,
    {
      principalId: claim.principalId,
      key: claim.key,
      method: claim.method,
      path: claim.path,
      requestHash: claim.requestHash,
      status: claim.status,
      versionId: claim.versionId,
      expiresAt,
      now: claim.now,
    },
  );
  if (inserted.records.length === 1) {
    return { kind: "claimed" };
  }

  const existing = await tx.executeQuery<ClaimRow>(
    `SELECT method, path, request_hash, expires_at, resource_id
       FROM idempotency_keys
      WHERE principal_id = :principalId AND key = :key
      FOR UPDATE`,
    { principalId: claim.principalId, key: claim.key },
  );
  const row = existing.records[0];
  if (row === undefined) {
    return { kind: "conflict" };
  }
  if (row.expires_at.getTime() <= now) {
    await tx.executeQuery(
      `UPDATE idempotency_keys
          SET method = :method, path = :path, request_hash = :requestHash,
              status = :status, resource_id = :versionId, expires_at = :expiresAt,
              created_at = :now
        WHERE principal_id = :principalId AND key = :key`,
      {
        principalId: claim.principalId,
        key: claim.key,
        method: claim.method,
        path: claim.path,
        requestHash: claim.requestHash,
        status: claim.status,
        versionId: claim.versionId,
        expiresAt,
        now: claim.now,
      },
    );
    return { kind: "claimed" };
  }
  if (
    row.method === claim.method &&
    row.path === claim.path &&
    row.request_hash.equals(claim.requestHash) &&
    row.resource_id !== null
  ) {
    return { kind: "replay", versionId: row.resource_id };
  }
  return { kind: "conflict" };
}
