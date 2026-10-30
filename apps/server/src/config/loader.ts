import { DatabaseUrlError, parseDatabaseUrl } from "../db/url.js";
import { parseCidrList } from "./cidr.js";
import { ConfigError } from "./errors.js";
import {
  assertPrivateFile,
  assertRegularFile,
  booleanValue,
  domainListValue,
  durationValue,
  httpsUrlValue,
  integerValue,
  optionalValue,
  requiredValue,
  trimTrailingSlash,
} from "./parse.js";
import type { EnvMode, LogLevel, OidcConfig, OpenVaultConfig } from "./types.js";

const DEFAULT_PROXY_CIDRS = "172.16.0.0/12";
const ENV_MODES: readonly EnvMode[] = ["production", "development", "test"];
const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];

function envModeValue(environment: NodeJS.ProcessEnv): EnvMode {
  const raw = optionalValue(environment, "ENV_MODE");
  if (raw === undefined) {
    return "production";
  }
  const match = ENV_MODES.find((mode) => mode === raw);
  if (!match) {
    throw new ConfigError("ENV_MODE", "must be production, development, or test");
  }
  return match;
}

function logLevelValue(environment: NodeJS.ProcessEnv): LogLevel {
  const raw = optionalValue(environment, "OPENVAULT_LOG_LEVEL");
  if (raw === undefined) {
    return "info";
  }
  const match = LOG_LEVELS.find((level) => level === raw);
  if (!match) {
    throw new ConfigError("OPENVAULT_LOG_LEVEL", "must be error, warn, info, or debug");
  }
  return match;
}

function adminPortValue(environment: NodeJS.ProcessEnv): number {
  const explicit = optionalValue(environment, "OPENVAULT_ADMIN_PORT");
  const alias = optionalValue(environment, "PORT");

  if (explicit !== undefined && alias !== undefined && explicit !== alias) {
    throw new ConfigError("OPENVAULT_ADMIN_PORT", "conflicts with PORT");
  }
  const raw = explicit ?? alias;
  if (raw === undefined) {
    return 8443;
  }
  return integerValue({ OPENVAULT_ADMIN_PORT: raw }, "OPENVAULT_ADMIN_PORT", 8443, 1, 65_535);
}

function oidcValue(environment: NodeJS.ProcessEnv, baseUrl: URL): OidcConfig | undefined {
  const issuerRaw = optionalValue(environment, "OPENVAULT_OIDC_ISSUER");
  const clientId = optionalValue(environment, "OPENVAULT_OIDC_CLIENT_ID");
  const clientSecret = optionalValue(environment, "OPENVAULT_OIDC_CLIENT_SECRET");
  const redirectRaw = optionalValue(environment, "OPENVAULT_OIDC_REDIRECT_URL");
  const allowedRaw = optionalValue(environment, "OPENVAULT_OIDC_ALLOWED_DOMAINS");

  if (issuerRaw === undefined) {
    if (
      clientId !== undefined ||
      clientSecret !== undefined ||
      redirectRaw !== undefined ||
      allowedRaw !== undefined
    ) {
      throw new ConfigError(
        "OPENVAULT_OIDC_ISSUER",
        "is required when any other OIDC value is configured",
      );
    }
    return undefined;
  }

  const issuer = httpsUrlValue("OPENVAULT_OIDC_ISSUER", issuerRaw);
  if (clientId === undefined) {
    throw new ConfigError("OPENVAULT_OIDC_CLIENT_ID", "is required when OIDC is configured");
  }
  if (clientSecret === undefined) {
    throw new ConfigError("OPENVAULT_OIDC_CLIENT_SECRET", "is required when OIDC is configured");
  }

  const redirectUrl =
    redirectRaw === undefined
      ? new URL(`${baseUrl.href.replace(/\/$/, "")}/v1/auth/callback`)
      : httpsUrlValue("OPENVAULT_OIDC_REDIRECT_URL", redirectRaw);

  return Object.freeze({
    issuer,
    clientId,
    clientSecret,
    redirectUrl,
    allowedDomains: domainListValue(environment, "OPENVAULT_OIDC_ALLOWED_DOMAINS"),
  });
}

/**
 * Validates and normalises the complete runtime environment.
 *
 * The loader never reads files it is not told to read, never mutates the
 * environment, and never includes a secret value in an error. All checks run
 * before migrations or socket binding, so a bad value cannot half-start the
 * service.
 *
 * @param environment - Environment values; defaults to `process.env`.
 * @returns A frozen, fully validated configuration.
 * @throws {ConfigError} When a required value is missing, malformed, or unsafe.
 *
 * @example
 * ```ts
 * const config = loadConfig(process.env);
 * console.log(config.adminPort);
 * ```
 */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env): OpenVaultConfig {
  const baseUrl = trimTrailingSlash(
    httpsUrlValue("OPENVAULT_BASE_URL", requiredValue(environment, "OPENVAULT_BASE_URL")),
  );

  const databaseUrl = requiredValue(environment, "OPENVAULT_DB_URL");
  let database: ReturnType<typeof parseDatabaseUrl>;
  try {
    database = parseDatabaseUrl(databaseUrl);
  } catch (error) {
    if (error instanceof DatabaseUrlError) {
      throw new ConfigError("OPENVAULT_DB_URL", error.message);
    }
    throw error;
  }

  const adminPort = adminPortValue(environment);
  const agentPort = integerValue(environment, "OPENVAULT_AGENT_PORT", 8444, 1, 65_535);
  if (agentPort === adminPort) {
    throw new ConfigError("OPENVAULT_AGENT_PORT", "must differ from OPENVAULT_ADMIN_PORT");
  }

  const keyringPath = assertPrivateFile(
    "OPENVAULT_KEYRING",
    requiredValue(environment, "OPENVAULT_KEYRING"),
  );
  const passphrasePath = optionalValue(environment, "OPENVAULT_KEYRING_PASSPHRASE_FILE");
  if (passphrasePath !== undefined) {
    assertPrivateFile("OPENVAULT_KEYRING_PASSPHRASE_FILE", passphrasePath);
    throw new ConfigError(
      "OPENVAULT_KEYRING_PASSPHRASE_FILE",
      "age-encrypted keyrings are deferred; the unsupported feature must be unset",
    );
  }

  const tlsCertPath = assertRegularFile(
    "OPENVAULT_TLS_CERT",
    requiredValue(environment, "OPENVAULT_TLS_CERT"),
  );
  const tlsKeyPath = assertRegularFile(
    "OPENVAULT_TLS_KEY",
    requiredValue(environment, "OPENVAULT_TLS_KEY"),
  );
  const internalCaPath = assertRegularFile(
    "OPENVAULT_INTERNAL_CA",
    requiredValue(environment, "OPENVAULT_INTERNAL_CA"),
  );

  const proxyCidrs = parseCidrList(
    environment.OPENVAULT_PROXY_CIDRS === undefined
      ? DEFAULT_PROXY_CIDRS
      : environment.OPENVAULT_PROXY_CIDRS,
  );
  const oidc = oidcValue(environment, baseUrl);

  const config: OpenVaultConfig = {
    baseUrl,
    adminPort,
    agentPort,
    envMode: envModeValue(environment),
    databaseUrl,
    database: Object.freeze(database),
    keyringPath,
    ...(passphrasePath === undefined ? {} : { keyringPassphrasePath: passphrasePath }),
    tlsCertPath,
    tlsKeyPath,
    internalCaPath,
    ...(oidc === undefined ? {} : { oidc }),
    secretMaxBytes: integerValue(
      environment,
      "OPENVAULT_SECRET_MAX_BYTES",
      65_536,
      1_024,
      1_048_576,
    ),
    certMaxBytes: integerValue(environment, "OPENVAULT_CERT_MAX_BYTES", 131_072, 1_024, 2_097_152),
    softDeleteDays: integerValue(environment, "OPENVAULT_SOFT_DELETE_DAYS", 30, 7, 90),
    auditRetentionDays: integerValue(environment, "OPENVAULT_AUDIT_RETENTION_DAYS", 180, 30, 3_650),
    joinTokenTtlMs: durationValue(
      environment,
      "OPENVAULT_JOIN_TOKEN_TTL",
      15 * 60_000,
      60_000,
      24 * 3_600_000,
    ),
    certTtlDays: integerValue(environment, "OPENVAULT_CERT_TTL_DAYS", 30, 1, 90),
    sessionTtlHours: integerValue(environment, "OPENVAULT_SESSION_TTL_HOURS", 8, 1, 24),
    trustProxy: booleanValue(environment, "OPENVAULT_TRUST_PROXY", true),
    proxyCidrs,
    logLevel: logLevelValue(environment),
  };

  return Object.freeze(config);
}
