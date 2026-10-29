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
