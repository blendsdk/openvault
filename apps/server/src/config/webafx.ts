import type { OpenVaultConfig, WebAfxSettings } from "./types.js";

const LOG_LEVELS = {
  error: "ERROR",
  warn: "WARN",
  info: "INFO",
  debug: "DEBUG",
} as const;

/**
 * Maps the typed configuration onto the six standard WebAFX settings.
 *
 * Custom and secret values stay in {@link OpenVaultConfig}; they are not placed
 * in WebAFX's passthrough settings, which request-scoped services can read.
 * Proxy trust and CORS are deliberately disabled here because the transport
 * layer owns both decisions.
 *
 * @param config - Validated runtime configuration.
 * @returns The standard WebAFX settings only.
 *
 * @example
 * ```ts
 * const app = new WebApplication(createWebApplicationConfig(config));
 * ```
 */
export function createWebApplicationConfig(config: OpenVaultConfig): WebAfxSettings {
  return {
    PORT: config.adminPort,
    ENV_MODE: config.envMode,
    LOG_LEVEL: LOG_LEVELS[config.logLevel],
    BODY_LIMIT: "128kb",
    CORS: false,
    TRUST_PROXY: false,
  };
}
