import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ConfigError } from "./errors.js";

/** Reads an optional environment value, treating an empty string as absent. */
export function optionalValue(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = environment[key];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

/**
 * Parses an integer within an inclusive range.
 *
 * The parser rejects decimals, exponents, signs, and empty text instead of
 * accepting whatever `Number()` happens to coerce.
 */
export function integerValue(
  environment: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = optionalValue(environment, key);
  if (raw === undefined) {
    return defaultValue;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new ConfigError(key, "must be an integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigError(key, `must be between ${minimum} and ${maximum}`);
  }
  return value;
}

/**
 * Parses a duration such as `15m` or `24h` into milliseconds.
 *
 * Supported units are `ms`, `s`, `m`, and `h`.
 */
export function durationValue(
  environment: NodeJS.ProcessEnv,
  key: string,
  defaultValueMs: number,
  minimumMs: number,
  maximumMs: number,
): number {
  const raw = optionalValue(environment, key);
  if (raw === undefined) {
    return defaultValueMs;
  }

  const match = /^(\d+)(ms|s|m|h)$/.exec(raw.trim());
  if (!match) {
    throw new ConfigError(key, "must be a duration such as 15m or 24h");
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  const value = amount * multiplier;
  if (!Number.isSafeInteger(value) || value < minimumMs || value > maximumMs) {
    throw new ConfigError(key, "is outside the allowed duration range");
  }
  return value;
}

/** Parses an absolute HTTPS URL without credentials, a query, or a fragment. */
export function httpsUrlValue(key: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(key, "must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new ConfigError(key, "must use HTTPS");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new ConfigError(key, "must not contain credentials");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new ConfigError(key, "must not contain a query or fragment");
  }
  return url;
}

/**
 * Removes one trailing slash from a URL path.
 *
 * The base URL keeps any path component, so a deployment under
 * `https://vault.example.com/openvault/` normalises consistently.
 */
export function trimTrailingSlash(url: URL): URL {
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    const copy = new URL(url.href);
    copy.pathname = copy.pathname.slice(0, -1);
    return copy;
  }
  return url;
}

/** Checks that a value is an absolute path to an existing regular file. */
export function assertRegularFile(key: string, raw: string): string {
  if (!isAbsolute(raw)) {
    throw new ConfigError(key, "must be an absolute path");
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(raw);
  } catch {
    throw new ConfigError(key, "must reference a readable file");
  }
  if (!stats.isFile()) {
    throw new ConfigError(key, "must reference a regular file");
  }
  try {
    accessSync(raw, constants.R_OK);
  } catch {
    throw new ConfigError(key, "must be readable");
  }
  return raw;
}

/** Checks that a file exists and has exactly `0600` permission bits. */
export function assertPrivateFile(key: string, raw: string): string {
  const path = assertRegularFile(key, raw);
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) {
    throw new ConfigError(key, "must have mode 0600");
  }
  return path;
}

/** Parses a comma-separated domain allowlist and validates each label. */
export function domainListValue(environment: NodeJS.ProcessEnv, key: string): readonly string[] {
  const raw = optionalValue(environment, key);
  if (raw === undefined) {
    return Object.freeze([]);
  }

  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  const domains = raw.split(",").map((entry) => entry.trim().toLowerCase());
  for (const domain of domains) {
    if (domain.length === 0 || domain.length > 253) {
      throw new ConfigError(key, "must contain valid domain names");
    }
    if (!domain.split(".").every((part) => label.test(part))) {
      throw new ConfigError(key, "must contain valid domain names");
    }
  }
  return Object.freeze(domains);
}
