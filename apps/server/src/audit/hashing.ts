import { createHash, createHmac } from "node:crypto";
import type { AuditAction } from "@openvault/api-contract";
import type {
  AuditActorKind,
  AuditDetailValue,
  AuditEventInput,
  AuditResult,
  AuditScopeType,
} from "./types.js";

/** The exact object covered by the chain hash. */
export interface CanonicalAuditEvent {
  /** Event ULID. */
  readonly eventId: string;
  /** Millisecond ISO timestamp. */
  readonly ts: string;
  /** Owning project, or null. */
  readonly projectId: string | null;
  /** Correlation id. */
  readonly requestId: string;
  /** Acting principal, or null. */
  readonly actorId: string | null;
  /** Actor class. */
  readonly actorKind: AuditActorKind;
  /** Frozen action. */
  readonly action: AuditAction;
  /** Scope class. */
  readonly scopeType: AuditScopeType;
  /** Scope identifier, or null. */
  readonly scopeId: string | null;
  /** Resource type, or null. */
  readonly objectType: string | null;
  /** Resource identifier, or null. */
  readonly objectId: string | null;
  /** Outcome. */
  readonly result: AuditResult;
  /** Canonical client address, or null. */
  readonly sourceIp: string | null;
  /** Stored user agent, or null. */
  readonly userAgent: string | null;
  /** Action-specific evidence. */
  readonly details: Readonly<Record<string, AuditDetailValue>>;
  /** Previous hash as lowercase hexadecimal. */
  readonly prevHash: string;
  /** Key used for the HMAC. */
  readonly auditKeyId: string;
}

/**
 * Builds the object that is serialized and hashed for one event.
 *
 * The previous hash is represented as lowercase hex inside the canonical
 * object; the raw bytes are still the hash prefix. Keeping both representations
 * explicit prevents a writer and a verifier from hashing different bytes.
 *
 * @param event - Event with identity and timestamp assigned.
 * @param prevHash - Previous 32-byte hash.
 * @param auditKeyId - Key selected for this event.
 * @returns The canonical object.
 */
export function canonicalEventForHash(
  event: AuditEventInput,
  prevHash: Buffer,
  auditKeyId: string,
): CanonicalAuditEvent {
  return {
    eventId: event.eventId,
    ts: event.ts.toISOString(),
    projectId: event.projectId,
    requestId: event.requestId,
    actorId: event.actorId,
    actorKind: event.actorKind,
    action: event.action,
    scopeType: event.scopeType,
    scopeId: event.scopeId,
    objectType: event.objectType,
    objectId: event.objectId,
    result: event.result,
    sourceIp: event.sourceIp,
    userAgent: event.userAgent,
    details: event.details,
    prevHash: prevHash.toString("hex"),
    auditKeyId,
  };
}

/**
 * Hashes raw previous-hash bytes followed by the already-serialized canonical
 * UTF-8 string.
 *
 * The caller passes the exact output of `canonicalJson`; this function never
 * serializes a second time.
 *
 * @param canonicalJson - Canonical UTF-8 string.
 * @param prevHash - Previous 32-byte hash.
 * @returns The 32-byte chain hash.
 */
export function computeEventHash(canonicalJson: string, prevHash: Buffer): Buffer {
  return createHash("sha256")
    .update(Buffer.concat([prevHash, Buffer.from(canonicalJson, "utf8")]))
    .digest();
}

/**
 * Computes the HMAC-SHA256 of one chain hash.
 *
 * @param key - Unwrapped 32-byte audit key.
 * @param hash - 32-byte chain hash.
 * @returns The 32-byte HMAC.
 */
export function computeEventHmac(key: Readonly<Buffer>, hash: Buffer): Buffer {
  return createHmac("sha256", key).update(hash).digest();
}

/**
 * Computes the HMAC stored on a checkpoint.
 *
 * The input is the decimal sequence id as ASCII digits followed by exactly 32
 * hash bytes, so the boundary between the two parts is unambiguous.
 *
 * @param key - Unwrapped 32-byte audit key.
 * @param lastEventSequenceId - Decimal bigint string.
 * @param lastHash - 32-byte hash of the referenced event.
 * @returns The 32-byte checkpoint HMAC.
 */
export function computeCheckpointHmac(
  key: Readonly<Buffer>,
  lastEventSequenceId: string,
  lastHash: Buffer,
): Buffer {
  return createHmac("sha256", key)
    .update(Buffer.from(lastEventSequenceId, "utf8"))
    .update(lastHash)
    .digest();
}
