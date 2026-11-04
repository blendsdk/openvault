import { CanonicalJsonError } from "./errors.js";

/** Maximum nesting depth accepted for one value. */
const MAX_DEPTH = 8;

/** Maximum encoded length accepted for one value. */
const MAX_OUTPUT_BYTES = 64 * 1_024;

/** A JSON value accepted by the canonical encoder. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/** Returns true when a string contains an unpaired UTF-16 surrogate code unit. */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Returns true when a value is a plain object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Serializes one supported value into the canonical buffer parts. */
function serialize(value: unknown, depth: number, seen: Set<object>, path: string): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`Non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case "string":
      if (hasLoneSurrogate(value)) {
        throw new CanonicalJsonError(`Lone surrogate at ${path}`);
      }
      if (value.includes("\u0000")) {
        throw new CanonicalJsonError(`Null character at ${path}`);
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`Unsupported value at ${path}`);
  }

  if (depth >= MAX_DEPTH) {
    throw new CanonicalJsonError(`Value exceeds the depth bound at ${path}`);
  }
  if (seen.has(value)) {
    throw new CanonicalJsonError(`Cycle at ${path}`);
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((entry, index) =>
        serialize(entry, depth + 1, seen, `${path}[${index}]`),
      );
      return `[${items.join(",")}]`;
    }
    if (!isPlainObject(value)) {
      throw new CanonicalJsonError(`Non-plain object at ${path}`);
    }
    const keys = Object.keys(value).sort();
    const entries = keys.map((key) => {
      if (hasLoneSurrogate(key)) {
        throw new CanonicalJsonError(`Lone surrogate in key at ${path}`);
      }
      if (key.includes("\u0000")) {
        throw new CanonicalJsonError(`Null character in key at ${path}`);
      }
      return `${JSON.stringify(key)}:${serialize(value[key], depth + 1, seen, `${path}.${key}`)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Serializes a value with sorted object keys and no insignificant whitespace.
 *
 * The same input always produces the same UTF-8 string, which is the first
 * half of the chain hash. Unsupported values are rejected instead of being
 * coerced, so a writer and a verifier can never disagree silently.
 *
 * @param value - JSON-compatible value.
 * @returns The canonical serialization.
 * @throws {CanonicalJsonError} For unsupported values, cycles, lone surrogates,
 *   depth above eight, or output above the configured bound.
 *
 * @example
 * ```ts
 * canonicalJson({ b: 1, a: 2 }); // '{"a":2,"b":1}'
 * ```
 */
export function canonicalJson(value: unknown): string {
  const encoded = serialize(value, 0, new Set(), "$");
  if (Buffer.byteLength(encoded, "utf8") > MAX_OUTPUT_BYTES) {
    throw new CanonicalJsonError("Value exceeds the output bound");
  }
  return encoded;
}
