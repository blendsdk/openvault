import type { PostgreSQLConfig } from "blendsdk/postgresql";

/** Raised when a database URL is missing or structurally invalid. */
export class DatabaseUrlError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DatabaseUrlError";
  }
}

/**
 * Converts a PostgreSQL URL into the configuration expected by `PostgreSQLDatabase`.
 *
 * Only the connection shape is validated here. Credentials are never included in error
 * messages, and the parser does not attempt network access.
 *
 * @param rawUrl - PostgreSQL URL, for example `postgres://user:pass@db:5432/openvault`.
 * @returns Connection settings for the database adapter.
 * @throws {DatabaseUrlError} When the URL is malformed or omits required parts.
 *
 * @example
 * ```ts
 * const config = parseDatabaseUrl("postgres://openvault:secret@db:5432/openvault");
 * ```
 */
export function parseDatabaseUrl(rawUrl: string): PostgreSQLConfig {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new DatabaseUrlError("Database URL is not a valid URL.");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new DatabaseUrlError("Database URL must use the postgres protocol.");
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host) {
    throw new DatabaseUrlError("Database URL must include a host.");
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database || database.includes("/") || database.includes("\\")) {
    throw new DatabaseUrlError("Database URL must include a database name.");
  }

  const user = decodeURIComponent(parsed.username);
  if (!user) {
    throw new DatabaseUrlError("Database URL must include a user.");
  }

  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new DatabaseUrlError("Database URL has an invalid port.");
  }

  const config: PostgreSQLConfig = {
    host,
    port,
    database,
    user,
  };
  const password = decodeURIComponent(parsed.password);
  if (password) {
    config.pass = password;
  }
  return config;
}
