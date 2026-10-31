import { formatCidr } from "./cidr.js";
import type { OpenVaultConfig, RedactedOpenVaultConfig } from "./types.js";

/**
 * Builds a support-safe view of the validated configuration.
 *
 * The result is assembled from an explicit allowlist, not by spreading the
 * configuration. The raw database URL and every secret are omitted: the
 * database password appears only as `***`, and OIDC settings appear only when
 * they are configured.
 *
 * @param config - Validated runtime configuration.
 * @returns A JSON-safe object with no secret values.
 *
 * @example
 * ```ts
 * const supportDump = toRedactedConfig(config);
 * console.log(JSON.stringify(supportDump, null, 2));
 * ```
 */
export function toRedactedConfig(config: OpenVaultConfig): RedactedOpenVaultConfig {
  return {
    baseUrl: config.baseUrl.href,
    adminPort: config.adminPort,
    agentPort: config.agentPort,
    envMode: config.envMode,
    database: {
      host: config.database.host ?? "",
      port:
        typeof config.database.port === "number"
          ? config.database.port
          : Number(config.database.port ?? 5432),
      database: config.database.database ?? "",
      user: config.database.user ?? "",
      pass: "***",
    },
    keyringPath: config.keyringPath,
    ...(config.keyringPassphrasePath === undefined
      ? {}
      : { keyringPassphrasePath: config.keyringPassphrasePath }),
    tlsCertPath: config.tlsCertPath,
    tlsKeyPath: config.tlsKeyPath,
    internalCaPath: config.internalCaPath,
    ...(config.oidc === undefined
      ? {}
      : {
          oidc: {
            issuer: config.oidc.issuer.href,
            clientId: config.oidc.clientId,
            clientSecret: "***" as const,
            redirectUrl: config.oidc.redirectUrl.href,
            allowedDomains: config.oidc.allowedDomains,
          },
        }),
    secretMaxBytes: config.secretMaxBytes,
    certMaxBytes: config.certMaxBytes,
    softDeleteDays: config.softDeleteDays,
    auditRetentionDays: config.auditRetentionDays,
    joinTokenTtlMs: config.joinTokenTtlMs,
    certTtlDays: config.certTtlDays,
    sessionTtlHours: config.sessionTtlHours,
    trustProxy: config.trustProxy,
    proxyCidrs: config.proxyCidrs.map(formatCidr),
    logLevel: config.logLevel,
  };
}
