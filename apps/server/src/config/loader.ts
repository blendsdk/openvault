import { z } from "zod";
import { DatabaseUrlError, parseDatabaseUrl } from "../db/url.js";
import { parseCidrList } from "./cidr.js";
import { ConfigError } from "./errors.js";
import {
  assertPrivateFile,
  assertRegularFile,
  domainListValue,
  durationValue,
  httpsUrlValue,
  integerValue,
  trimTrailingSlash,
} from "./parse.js";
import type { EnvMode, LogLevel, OidcConfig, OpenVaultConfig } from "./types.js";

const DEFAULT_PROXY_CIDRS = "172.16.0.0/12";
const ENV_MODES = ["production", "development", "test"] as const;
const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;

/** Maps a blank optional environment value to the same representation as absent. */
function blankToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

/** Treats a blank optional value the same way an absent value is treated. */
const optionalString = z.preprocess(blankToUndefined, z.string().optional());

/**
 * Wraps a field parser so a {@link ConfigError} becomes a Zod issue on that
 * field. The issue message never contains the offending value.
 */
function requiredField<T>(_key: string, parser: (value: string) => T) {
  return z
    .string({ error: "is required" })
    .trim()
    .min(1, "is required")
    .transform((value, context): T => {
      try {
        return parser(value);
      } catch (error) {
        context.addIssue({
          code: "custom",
          message: error instanceof ConfigError ? error.reason : "is invalid",
        });
        return z.NEVER;
      }
    });
}

/** Parses an optional integer field, falling back to the documented default. */
function integerField(key: string, defaultValue: number, minimum: number, maximum: number) {
  return optionalString.transform((value, context): number => {
    try {
      return integerValue(
        value === undefined ? {} : { [key]: value },
        key,
        defaultValue,
        minimum,
        maximum,
      );
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof ConfigError ? error.reason : "is invalid",
      });
      return z.NEVER;
    }
  });
}

/** Parses an optional port field without applying a default. */
function portField() {
  return optionalString.transform((value, context): number | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (!/^\d+$/.test(value.trim())) {
      context.addIssue({ code: "custom", message: "must be an integer" });
      return z.NEVER;
    }
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      context.addIssue({ code: "custom", message: "must be between 1 and 65535" });
      return z.NEVER;
    }
    return port;
  });
}

/** Parses an optional duration field in milliseconds. */
function durationField(key: string, defaultValue: number, minimum: number, maximum: number) {
  return optionalString.transform((value, context): number => {
    try {
      return durationValue(
        value === undefined ? {} : { [key]: value },
        key,
        defaultValue,
        minimum,
        maximum,
      );
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof ConfigError ? error.reason : "is invalid",
      });
      return z.NEVER;
    }
  });
}

function buildOidc(
  raw: {
    readonly issuer?: string | undefined;
    readonly clientId?: string | undefined;
    readonly clientSecret?: string | undefined;
    readonly redirect?: string | undefined;
    readonly allowedDomains?: string | undefined;
  },
  baseUrl: URL,
  context: z.RefinementCtx,
): OidcConfig | undefined {
  const { issuer, clientId, clientSecret, redirect, allowedDomains } = raw;

  if (issuer === undefined) {
    if (
      clientId !== undefined ||
      clientSecret !== undefined ||
      redirect !== undefined ||
      allowedDomains !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPENVAULT_OIDC_ISSUER"],
        message: "is required when any other OIDC value is configured",
      });
    }
    return undefined;
  }

  let issuerUrl: URL;
  try {
    issuerUrl = httpsUrlValue("OPENVAULT_OIDC_ISSUER", issuer);
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["OPENVAULT_OIDC_ISSUER"],
      message: error instanceof ConfigError ? error.reason : "is invalid",
    });
    return undefined;
  }

  if (clientId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["OPENVAULT_OIDC_CLIENT_ID"],
      message: "is required when OIDC is configured",
    });
    return undefined;
  }
  if (clientSecret === undefined) {
    context.addIssue({
      code: "custom",
      path: ["OPENVAULT_OIDC_CLIENT_SECRET"],
      message: "is required when OIDC is configured",
    });
    return undefined;
  }

  let redirectUrl: URL;
  try {
    redirectUrl =
      redirect === undefined
        ? new URL(`${baseUrl.href.replace(/\/$/, "")}/v1/auth/callback`)
        : httpsUrlValue("OPENVAULT_OIDC_REDIRECT_URL", redirect);
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["OPENVAULT_OIDC_REDIRECT_URL"],
      message: error instanceof ConfigError ? error.reason : "is invalid",
    });
    return undefined;
  }

  let domains: readonly string[];
  try {
    domains = domainListValue(
      allowedDomains === undefined ? {} : { OPENVAULT_OIDC_ALLOWED_DOMAINS: allowedDomains },
      "OPENVAULT_OIDC_ALLOWED_DOMAINS",
    );
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["OPENVAULT_OIDC_ALLOWED_DOMAINS"],
      message: error instanceof ConfigError ? error.reason : "is invalid",
    });
    return undefined;
  }

  return Object.freeze({
    issuer: issuerUrl,
    clientId,
    clientSecret,
    redirectUrl,
    allowedDomains: domains,
  });
}

const configSchema = z
  .object({
    OPENVAULT_BASE_URL: requiredField("OPENVAULT_BASE_URL", (value) =>
      trimTrailingSlash(httpsUrlValue("OPENVAULT_BASE_URL", value)),
    ),
    OPENVAULT_DB_URL: requiredField("OPENVAULT_DB_URL", (value) => {
      try {
        return { raw: value, parsed: parseDatabaseUrl(value) };
      } catch (error) {
        if (error instanceof DatabaseUrlError) {
          throw new ConfigError("OPENVAULT_DB_URL", error.message);
        }
        throw new ConfigError("OPENVAULT_DB_URL", "must be a valid PostgreSQL URL");
      }
    }),
    ENV_MODE: z
      .preprocess(blankToUndefined, z.enum(ENV_MODES).optional())
      .transform((value): EnvMode => value ?? "production"),
    PORT: portField(),
    OPENVAULT_ADMIN_PORT: portField(),
    OPENVAULT_AGENT_PORT: portField(),
    OPENVAULT_KEYRING: requiredField("OPENVAULT_KEYRING", (value) =>
      assertPrivateFile("OPENVAULT_KEYRING", value),
    ),
    OPENVAULT_KEYRING_PASSPHRASE_FILE: optionalString.transform(
      (value, context): string | undefined => {
        if (value === undefined) {
          return undefined;
        }
        try {
          assertPrivateFile("OPENVAULT_KEYRING_PASSPHRASE_FILE", value);
        } catch (error) {
          context.addIssue({
            code: "custom",
            message: error instanceof ConfigError ? error.reason : "is invalid",
          });
          return z.NEVER;
        }
        context.addIssue({
          code: "custom",
          message: "age-encrypted keyrings are deferred; the unsupported feature must be unset",
        });
        return z.NEVER;
      },
    ),
    OPENVAULT_TLS_CERT: requiredField("OPENVAULT_TLS_CERT", (value) =>
      assertRegularFile("OPENVAULT_TLS_CERT", value),
    ),
    OPENVAULT_TLS_KEY: requiredField("OPENVAULT_TLS_KEY", (value) =>
      assertRegularFile("OPENVAULT_TLS_KEY", value),
    ),
    OPENVAULT_INTERNAL_CA: requiredField("OPENVAULT_INTERNAL_CA", (value) =>
      assertRegularFile("OPENVAULT_INTERNAL_CA", value),
    ),
    OPENVAULT_PROXY_CIDRS: z
      .string()
      .optional()
      .transform((value, context) => {
        try {
          return parseCidrList(value === undefined ? DEFAULT_PROXY_CIDRS : value);
        } catch (error) {
          context.addIssue({
            code: "custom",
            message: error instanceof ConfigError ? error.reason : "is invalid",
          });
          return z.NEVER;
        }
      }),
    OPENVAULT_LOG_LEVEL: z
      .preprocess(blankToUndefined, z.enum(LOG_LEVELS).optional())
      .transform((value): LogLevel => value ?? "info"),
    OPENVAULT_TRUST_PROXY: z
      .preprocess(blankToUndefined, z.enum(["true", "false"]).optional())
      .transform((value): boolean => (value === undefined ? true : value === "true")),
    OPENVAULT_OIDC_ISSUER: optionalString,
    OPENVAULT_OIDC_CLIENT_ID: optionalString,
    OPENVAULT_OIDC_CLIENT_SECRET: optionalString,
    OPENVAULT_OIDC_REDIRECT_URL: optionalString,
    OPENVAULT_OIDC_ALLOWED_DOMAINS: optionalString,
    OPENVAULT_SECRET_MAX_BYTES: integerField(
      "OPENVAULT_SECRET_MAX_BYTES",
      65_536,
      1_024,
      1_048_576,
    ),
    OPENVAULT_CERT_MAX_BYTES: integerField("OPENVAULT_CERT_MAX_BYTES", 131_072, 1_024, 2_097_152),
    OPENVAULT_SOFT_DELETE_DAYS: integerField("OPENVAULT_SOFT_DELETE_DAYS", 30, 7, 90),
    OPENVAULT_AUDIT_RETENTION_DAYS: integerField("OPENVAULT_AUDIT_RETENTION_DAYS", 180, 30, 3_650),
    OPENVAULT_JOIN_TOKEN_TTL: durationField(
      "OPENVAULT_JOIN_TOKEN_TTL",
      15 * 60_000,
      60_000,
      24 * 3_600_000,
    ),
    OPENVAULT_CERT_TTL_DAYS: integerField("OPENVAULT_CERT_TTL_DAYS", 30, 1, 90),
    OPENVAULT_SESSION_TTL_HOURS: integerField("OPENVAULT_SESSION_TTL_HOURS", 8, 1, 24),
  })
  .superRefine((value, context) => {
    if (
      value.OPENVAULT_ADMIN_PORT !== undefined &&
      value.PORT !== undefined &&
      value.OPENVAULT_ADMIN_PORT !== value.PORT
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPENVAULT_ADMIN_PORT"],
        message: "conflicts with PORT",
      });
    }

    const adminPort = value.OPENVAULT_ADMIN_PORT ?? value.PORT ?? 8443;
    const agentPort = value.OPENVAULT_AGENT_PORT ?? 8444;
    if (agentPort === adminPort) {
      context.addIssue({
        code: "custom",
        path: ["OPENVAULT_AGENT_PORT"],
        message: "must differ from OPENVAULT_ADMIN_PORT",
      });
    }
  })
  .transform((value, context): OpenVaultConfig => {
    const adminPort = value.OPENVAULT_ADMIN_PORT ?? value.PORT ?? 8443;
    const agentPort = value.OPENVAULT_AGENT_PORT ?? 8444;
    const oidc = buildOidc(
      {
        issuer: value.OPENVAULT_OIDC_ISSUER,
        clientId: value.OPENVAULT_OIDC_CLIENT_ID,
        clientSecret: value.OPENVAULT_OIDC_CLIENT_SECRET,
        redirect: value.OPENVAULT_OIDC_REDIRECT_URL,
        allowedDomains: value.OPENVAULT_OIDC_ALLOWED_DOMAINS,
      },
      value.OPENVAULT_BASE_URL,
      context,
    );

    return Object.freeze({
      baseUrl: value.OPENVAULT_BASE_URL,
      adminPort,
      agentPort,
      envMode: value.ENV_MODE,
      databaseUrl: value.OPENVAULT_DB_URL.raw,
      database: Object.freeze(value.OPENVAULT_DB_URL.parsed),
      keyringPath: value.OPENVAULT_KEYRING,
      ...(value.OPENVAULT_KEYRING_PASSPHRASE_FILE === undefined
        ? {}
        : { keyringPassphrasePath: value.OPENVAULT_KEYRING_PASSPHRASE_FILE }),
      tlsCertPath: value.OPENVAULT_TLS_CERT,
      tlsKeyPath: value.OPENVAULT_TLS_KEY,
      internalCaPath: value.OPENVAULT_INTERNAL_CA,
      ...(oidc === undefined ? {} : { oidc }),
      secretMaxBytes: value.OPENVAULT_SECRET_MAX_BYTES,
      certMaxBytes: value.OPENVAULT_CERT_MAX_BYTES,
      softDeleteDays: value.OPENVAULT_SOFT_DELETE_DAYS,
      auditRetentionDays: value.OPENVAULT_AUDIT_RETENTION_DAYS,
      joinTokenTtlMs: value.OPENVAULT_JOIN_TOKEN_TTL,
      certTtlDays: value.OPENVAULT_CERT_TTL_DAYS,
      sessionTtlHours: value.OPENVAULT_SESSION_TTL_HOURS,
      trustProxy: value.OPENVAULT_TRUST_PROXY,
      proxyCidrs: value.OPENVAULT_PROXY_CIDRS,
      logLevel: value.OPENVAULT_LOG_LEVEL,
    });
  });

/**
 * Validates and normalises the complete runtime environment with a Zod schema.
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
  const result = configSchema.safeParse(environment);
  if (!result.success) {
    const issue = result.error.issues[0];
    const key = issue?.path.length ? String(issue.path[0]) : "ENV";
    throw new ConfigError(key, issue?.message ?? "is invalid");
  }
  return result.data;
}
