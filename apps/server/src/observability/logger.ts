import type { Writable } from "node:stream";
import { PinoLoggerProvider } from "blendsdk/webafx-pino";
import type { OpenVaultConfig } from "../config/index.js";

/**
 * Path-based pino redaction rules.
 *
 * Pino wildcards cover exactly one nesting level. Handlers must log explicit
 * fields and must not log raw request bodies, configuration objects, or
 * arbitrary nested objects.
 */
export const REDACT_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "token",
  "value",
  "privateKey",
  "*.password",
  "*.token",
  "*.value",
  "*.privateKey",
  "req.body.password",
  "req.body.token",
  "req.body.value",
  "req.body.privateKey",
];

/**
 * Builds the shared pino provider used by the request logger and the pre-stack
 * error logger.
 *
 * @param config - Validated runtime configuration.
 * @param destination - Optional test destination for captured output.
 * @returns A configured pino provider.
 */
export function createLoggerProvider(
  config: OpenVaultConfig,
  destination?: Writable,
): PinoLoggerProvider {
  return new PinoLoggerProvider({
    level: config.logLevel,
    redact: [...REDACT_PATHS],
    ...(destination === undefined ? {} : { destination }),
  });
}
