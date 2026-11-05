import { OpsError } from "./errors.js";

/** The non-secret configuration manifest stored in a backup. */
export interface BackupConfigManifest {
  readonly baseUrl: string | null;
  readonly envMode: string;
  readonly adminPort: number;
  readonly agentPort: number;
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: "***";
  };
  readonly keyringPath: string;
  readonly tlsCertPath: string | null;
  readonly tlsKeyPath: string | null;
  readonly internalCaPath: string;
  readonly secretMaxBytes: number;
  readonly certMaxBytes: number;
  readonly softDeleteDays: number;
  readonly auditRetentionDays: number;
}

/** Parses one numeric environment value with a default. */
function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new OpsError("ops_configuration", `${name} must be a non-negative integer`);
  }
  return value;
}

/**
 * Builds the redacted configuration manifest without loading secrets.
 *
 * The database URL is parsed only to record its host, port, database, and user.
 * Its password is never copied into the archive.
 */
export function buildConfigManifest(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly databaseUrl: string;
  readonly keyringPath: string;
  readonly internalCaPath: string;
  readonly tlsCertPath?: string;
  readonly tlsKeyPath?: string;
}): BackupConfigManifest {
  let url: URL;
  try {
    url = new URL(options.databaseUrl);
  } catch (error) {
    throw new OpsError("ops_configuration", "The database URL is invalid", { cause: error });
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new OpsError("ops_configuration", "The database URL must use the postgres protocol");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database.length === 0) {
    throw new OpsError("ops_configuration", "The database URL must include a database name");
  }
  return {
    baseUrl: options.env.OPENVAULT_BASE_URL ?? null,
    envMode: options.env.ENV_MODE ?? "production",
    adminPort: numberEnv(options.env, "OPENVAULT_ADMIN_PORT", 8443),
    agentPort: numberEnv(options.env, "OPENVAULT_AGENT_PORT", 8444),
    database: {
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port.length === 0 ? 5432 : Number(url.port),
      database,
      user: decodeURIComponent(url.username),
      password: "***",
    },
    keyringPath: options.keyringPath,
    tlsCertPath: options.tlsCertPath ?? null,
    tlsKeyPath: options.tlsKeyPath ?? null,
    internalCaPath: options.internalCaPath,
    secretMaxBytes: numberEnv(options.env, "OPENVAULT_SECRET_MAX_BYTES", 65_536),
    certMaxBytes: numberEnv(options.env, "OPENVAULT_CERT_MAX_BYTES", 131_072),
    softDeleteDays: numberEnv(options.env, "OPENVAULT_SOFT_DELETE_DAYS", 30),
    auditRetentionDays: numberEnv(options.env, "OPENVAULT_AUDIT_RETENTION_DAYS", 180),
  };
}
