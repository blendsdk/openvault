import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const BINDING_BYTES = 32;

/** A new binding value and the hash stored with the OIDC state. */
export interface OidcBinding {
  /** Random value delivered in the `__Host-ov_oidc` cookie. */
  readonly value: string;
  /** SHA-256 hex digest stored in the state record. */
  readonly hash: string;
}

/** Hashes a binding value with SHA-256. */
export function hashOidcBinding(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Creates a browser binding for one OIDC login flow.
 *
 * The cookie carries the random value; the state carries only its hash.
 *
 * @returns The cookie value and the stored hash.
 */
export function createOidcBinding(): OidcBinding {
  const value = randomBytes(BINDING_BYTES).toString("base64url");
  return { value, hash: hashOidcBinding(value) };
}

/**
 * Compares a callback's binding cookie with the stored hash in constant time.
 *
 * @param value - Raw binding cookie value, if present.
 * @param expectedHash - SHA-256 hex digest from the state record.
 * @returns True when the cookie is present and matches.
 */
export function oidcBindingMatches(value: string | undefined, expectedHash: string): boolean {
  if (value === undefined) {
    return false;
  }
  const actual = Buffer.from(hashOidcBinding(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
