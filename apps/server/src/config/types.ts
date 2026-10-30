import type { PostgreSQLConfig } from "blendsdk/postgresql";

/** Supported WebAFX environment modes. */
export type EnvMode = "production" | "development" | "test";

/** Supported structured log levels. */
export type LogLevel = "error" | "warn" | "info" | "debug";

/** One validated IPv4 or IPv6 network. */
export interface Cidr {
  /** Network address without a prefix length. */
  readonly address: string;
  /** Number of significant leading bits. */
  readonly prefix: number;
  /** Address family of the network. */
  readonly family: "ipv4" | "ipv6";
}

/** Optional OIDC settings. They are validated only when an issuer is configured. */
export interface OidcConfig {
  /** Issuer URL used for discovery. */
  readonly issuer: URL;
  /** OAuth client identifier. */
  readonly clientId: string;
  /** OAuth client secret. Never logged or included in a support dump. */
  readonly clientSecret: string;
  /** Callback URL registered with the identity provider. */
  readonly redirectUrl: URL;
  /** Optional email-domain allowlist. */
  readonly allowedDomains: readonly string[];
}

/** A validated, normalised runtime configuration. */
export interface OpenVaultConfig {
  readonly baseUrl: URL;
  readonly adminPort: number;
  readonly agentPort: number;
  readonly envMode: EnvMode;
  readonly databaseUrl: string;
  readonly database: PostgreSQLConfig;
  readonly keyringPath: string;
  readonly keyringPassphrasePath?: string;
  readonly tlsCertPath: string;
  readonly tlsKeyPath: string;
  readonly internalCaPath: string;
  readonly oidc?: OidcConfig;
  readonly secretMaxBytes: number;
  readonly certMaxBytes: number;
  readonly softDeleteDays: number;
  readonly auditRetentionDays: number;
  readonly joinTokenTtlMs: number;
  readonly certTtlDays: number;
  readonly sessionTtlHours: number;
  readonly trustProxy: boolean;
  readonly proxyCidrs: readonly Cidr[];
  readonly logLevel: LogLevel;
}

/**
 * JSON-safe configuration for support output.
 *
 * The shape is an explicit allowlist: it omits the raw database URL and every
 * secret value. Adding a new secret to {@link OpenVaultConfig} does not leak it
 * here unless this type and {@link toRedactedConfig} are deliberately changed.
 */
export interface RedactedOpenVaultConfig {
  readonly baseUrl: string;
  readonly adminPort: number;
  readonly agentPort: number;
  readonly envMode: EnvMode;
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly pass: "***";
  };
  readonly keyringPath: string;
  readonly keyringPassphrasePath?: string;
  readonly tlsCertPath: string;
  readonly tlsKeyPath: string;
  readonly internalCaPath: string;
  readonly oidc?: {
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret: "***";
    readonly redirectUrl: string;
    readonly allowedDomains: readonly string[];
  };
  readonly secretMaxBytes: number;
  readonly certMaxBytes: number;
  readonly softDeleteDays: number;
  readonly auditRetentionDays: number;
  readonly joinTokenTtlMs: number;
  readonly certTtlDays: number;
  readonly sessionTtlHours: number;
  readonly trustProxy: boolean;
  readonly proxyCidrs: readonly string[];
  readonly logLevel: LogLevel;
}

/** Standard WebAFX settings passed across the typed-config boundary. */
export interface WebAfxSettings {
  readonly PORT: number;
  readonly ENV_MODE: EnvMode;
  readonly LOG_LEVEL: "ERROR" | "WARN" | "INFO" | "DEBUG";
  readonly BODY_LIMIT: "128kb";
  readonly CORS: false;
  readonly TRUST_PROXY: false;
}
