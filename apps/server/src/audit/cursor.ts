import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { type AuditQuery, normalizeAuditFilters } from "@openvault/api-contract";
import { canonicalJson } from "./canonical-json.js";
import { AuditQueryError } from "./errors.js";
import type { AuditVisibility } from "./types.js";

const CURSOR_DOMAIN = "ov:audit-cursor:v1:";
const CURSOR_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CURSOR_SEQUENCE = /^\d+$/;
const CURSOR_FILTER = /^[0-9a-f]{64}$/;

/** Decoded and signed cursor payload. */
export interface CursorPayload {
  /** Cursor format version. */
  readonly v: 1;
  /** Audit key that signed the cursor. */
  readonly kid: string;
  /** Sequence id of the last row on the previous page. */
  readonly id: string;
  /** Hexadecimal filter-and-visibility hash. */
  readonly f: string;
}

/** Encodes bytes as unpadded base64url. */
function base64url(value: Buffer): string {
  return value.toString("base64url");
}

/** Decodes one base64url segment. */
function fromBase64url(value: string): Buffer {
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new AuditQueryError("Cursor is malformed");
  }
}

/** Validates one decoded payload. */
function validatePayload(value: unknown): CursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuditQueryError("Cursor payload is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    typeof record.kid !== "string" ||
    !CURSOR_ULID.test(record.kid) ||
    typeof record.id !== "string" ||
    !CURSOR_SEQUENCE.test(record.id) ||
    typeof record.f !== "string" ||
    !CURSOR_FILTER.test(record.f)
  ) {
    throw new AuditQueryError("Cursor payload is malformed");
  }
  return { v: 1, kid: record.kid, id: record.id, f: record.f };
}

/** Computes the signature over the canonical payload. */
function signature(payload: CursorPayload, key: Readonly<Buffer>): Buffer {
  return createHmac("sha256", key).update(CURSOR_DOMAIN).update(canonicalJson(payload)).digest();
}

/**
 * Decodes one cursor without verifying its signature.
 *
 * @param raw - Cursor produced by {@link signCursor}.
 * @returns The decoded payload.
 * @throws {AuditQueryError} When the cursor is malformed.
 */
export function decodeCursor(raw: string): CursorPayload {
  const parts = raw.split(".");
  const bodyPart = parts[0];
  const signaturePart = parts[1];
  if (
    parts.length !== 2 ||
    bodyPart === undefined ||
    signaturePart === undefined ||
    bodyPart === "" ||
    signaturePart === ""
  ) {
    throw new AuditQueryError("Cursor is malformed");
  }
  const body = fromBase64url(bodyPart).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AuditQueryError("Cursor is malformed");
  }
  return validatePayload(parsed);
}

/**
 * Signs one cursor payload.
 *
 * @param payload - Cursor fields.
 * @param key - Unwrapped audit key.
 * @returns An opaque base64url cursor.
 */
export function signCursor(payload: CursorPayload, key: Readonly<Buffer>): string {
  const body = base64url(Buffer.from(canonicalJson(payload), "utf8"));
  return `${body}.${base64url(signature(payload, key))}`;
}

/**
 * Verifies one cursor against the expected filter hash.
 *
 * @param raw - Cursor to verify.
 * @param key - Unwrapped audit key named by the cursor.
 * @param expectedFilterHash - Hash of the current filters and visibility.
 * @returns The verified payload.
 * @throws {AuditQueryError} When the signature or filter binding does not match.
 */
export function verifyCursor(
  raw: string,
  key: Readonly<Buffer>,
  expectedFilterHash: string,
): CursorPayload {
  const payload = decodeCursor(raw);
  const parts = raw.split(".");
  const supplied = fromBase64url(parts[1] ?? "");
  const expected = signature(payload, key);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new AuditQueryError("Cursor signature is invalid");
  }
  const expectedFilter = Buffer.from(expectedFilterHash, "hex");
  const suppliedFilter = Buffer.from(payload.f, "hex");
  if (
    expectedFilter.length !== suppliedFilter.length ||
    !timingSafeEqual(expectedFilter, suppliedFilter)
  ) {
    throw new AuditQueryError("Cursor does not belong to these filters");
  }
  return payload;
}

/**
 * Computes the filter-and-visibility hash bound into a cursor.
 *
 * The page size and the cursor itself are excluded, so changing the page size
 * does not invalidate a cursor while changing a filter or visibility does.
 *
 * @param filters - Current query filters.
 * @param visibility - Effective project visibility.
 * @returns 64 lowercase hexadecimal characters.
 */
export function filterHash(filters: AuditQuery, visibility: AuditVisibility): string {
  const projectIds = visibility.kind === "projects" ? [...visibility.projectIds].sort() : [];
  const canonical = canonicalJson({
    filters: normalizeAuditFilters(filters),
    projectIds,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
