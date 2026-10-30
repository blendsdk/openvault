import type { Writable } from "node:stream";
import { PinoLoggerProvider } from "blendsdk/webafx-pino";
import type { OpenVaultConfig } from "../config/index.js";

/**
 * Path-based pino redaction rules.
 *
 * Pino wildcards cover exactly one nesting level. Handlers must log explicit
 * fields and must not log raw request bodies, configuration objects, or
 * arbitrary nested objects. The auth fields are defense in depth: the primary
 * rule is still that handlers never log bodies or token responses.
 */
export const REDACT_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "currentPassword",
  "newPassword",
  "csrfToken",
  "token",
  "codeVerifier",
  "nonce",
  "idToken",
  "accessToken",
  "refreshToken",
  "secretId",
  "sessionSecret",
  "value",
  "privateKey",
  "*.password",
  "*.currentPassword",
  "*.newPassword",
  "*.csrfToken",
  "*.token",
  "*.codeVerifier",
  "*.nonce",
  "*.idToken",
  "*.accessToken",
  "*.refreshToken",
  "*.secretId",
  "*.sessionSecret",
  "*.query.code",
  "*.query.state",
  "*.value",
  "*.privateKey",
  'req.headers["x-csrf-token"]',
  'req.cookies["__Host-ov_session"]',
  "req.url",
  "req.originalUrl",
  "req.query.code",
  "req.query.state",
  "req.body.csrfToken",
  "req.body.password",
  "req.body.currentPassword",
  "req.body.newPassword",
  "req.body.token",
  "req.body.value",
  "req.body.privateKey",
];

const REQUEST_LOG_PATTERN = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\S+)( \d{3} \d+ms)$/;

/**
 * Removes the query string from one URL.
 *
 * @param value - URL or path, possibly with a query string.
 * @returns The value before the first `?`.
 */
function stripQuery(value: string): string {
  const index = value.indexOf("?");
  return index === -1 ? value : value.slice(0, index);
}

/**
 * Strips the query string from WebAFX's request-log message.
 *
 * WebAFX logs `METHOD <url> <status> <duration>ms` at info level, and the OIDC
 * callback URL contains a single-use authorization code and state. Only this
 * exact shape is rewritten; unrelated messages pass through unchanged.
 *
 * @param message - Candidate log message.
 * @returns The message with the request URL query removed.
 *
 * @example
 * ```ts
 * sanitizeLogMessage("GET /v1/auth/callback?code=abc&state=xyz 200 4ms");
 * // "GET /v1/auth/callback 200 4ms"
 * ```
 */
export function sanitizeLogMessage(message: string): string {
  const match = REQUEST_LOG_PATTERN.exec(message);
  if (match === null) {
    return message;
  }
  const method = match[1];
  const url = match[2];
  const suffix = match[3];
  if (method === undefined || url === undefined || suffix === undefined) {
    return message;
  }
  return `${method} ${stripQuery(url)}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shallow-sanitizes pino log arguments.
 *
 * String arguments are passed through {@link sanitizeLogMessage}. A plain
 * object with a string `url` property is copied with the query removed from
 * that property. Nested objects are intentionally not traversed: pino
 * redaction owns secret fields, and recursive rewriting would change unrelated
 * log data.
 *
 * @param args - Arguments passed to a pino log method.
 * @returns A new argument array with the request URL query removed.
 *
 * @example
 * ```ts
 * sanitizeLogArgs([{ url: "/v1/auth/callback?code=abc" }]);
 * // [{ url: "/v1/auth/callback" }]
 * ```
 */
export function sanitizeLogArgs(args: unknown[]): unknown[] {
  return args.map((argument) => {
    if (typeof argument === "string") {
      return sanitizeLogMessage(argument);
    }
    if (isRecord(argument) && typeof argument.url === "string") {
      return { ...argument, url: stripQuery(argument.url) };
    }
    return argument;
  });
}

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
    pinoOptions: {
      hooks: {
        logMethod(this: unknown, args: unknown[], method: (...values: unknown[]) => void): void {
          method.apply(this, sanitizeLogArgs(args));
        },
      },
    },
    ...(destination === undefined ? {} : { destination }),
  });
}
