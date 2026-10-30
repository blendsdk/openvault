import { randomBytes } from "node:crypto";

/**
 * A ULID string.
 *
 * ULIDs are 26 characters long and use Crockford's Base32 alphabet. The alphabet omits
 * `I`, `L`, `O`, and `U` so that identifiers cannot be confused with digits or with each
 * other when someone reads them aloud or copies them by hand.
 */
export type Ulid = string;

/**
 * The canonical ULID shape.
 *
 * The pattern is intentionally strict: callers should reject upper/lowercase variants that
 * are not part of Crockford's alphabet rather than normalizing them silently. It validates
 * the 26-character alphabet and length, not the 128-bit timestamp range; a canonical ULID
 * normally starts with `0`-`7`.
 *
 * @example
 * ```ts
 * ULID_PATTERN.test("01ARZ3NDEKTSV4RRFFQ69G5FAV"); // true
 * ULID_PATTERN.test("01ARZ3NDEKTSV4RRFFQ69G5FAI"); // false
 * ```
 */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Checks whether a value is a canonical ULID string.
 *
 * This is a type guard, so callers can narrow `unknown` input from JSON or HTTP headers
 * without an unsafe cast.
 *
 * @param value - Value to inspect.
 * @returns `true` when the value is a 26-character ULID.
 *
 * @example
 * ```ts
 * if (isUlid(request.id)) {
 *   // request.id is now a Ulid
 * }
 * ```
 */
export function isUlid(value: unknown): value is Ulid {
  return typeof value === "string" && ULID_PATTERN.test(value);
}

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_LENGTH = 26;
const RANDOM_BYTES = 10;
const MAX_TIMESTAMP = (1n << 48n) - 1n;
const RANDOM_MASK = (1n << 80n) - 1n;

/**
 * Generates a canonical ULID from the current time and 80 random bits.
 *
 * The first 10 characters encode the 48-bit millisecond timestamp, so ULIDs
 * generated at different times sort lexicographically in time order. The
 * remaining 16 characters are random. This generator is not monotonic within a
 * single millisecond: two calls can produce values whose random suffixes sort
 * in either order.
 *
 * @param now - Millisecond timestamp to encode. Defaults to `Date.now()`.
 * @returns A 26-character Crockford Base32 identifier.
 * @throws {RangeError} When `now` is not a finite, non-negative 48-bit integer.
 *
 * @example
 * ```ts
 * const id = newUlid();
 * isUlid(id); // true
 * ```
 */
export function newUlid(now: number = Date.now()): Ulid {
  if (!Number.isFinite(now) || now < 0) {
    throw new RangeError("ULID timestamp must be a finite, non-negative number");
  }

  const timestamp = BigInt(Math.floor(now));
  if (timestamp > MAX_TIMESTAMP) {
    throw new RangeError("ULID timestamp exceeds the 48-bit range");
  }

  const random = BigInt(`0x${randomBytes(RANDOM_BYTES).toString("hex")}`);
  const value = (timestamp << 80n) | (random & RANDOM_MASK);

  let result = "";
  let remaining = value;
  for (let index = 0; index < ULID_LENGTH; index += 1) {
    result = CROCKFORD_ALPHABET[Number(remaining & 31n)] + result;
    remaining >>= 5n;
  }
  return result;
}
