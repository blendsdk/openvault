import { randomUUID } from "node:crypto";
import { ApiError, ForbiddenError } from "blendsdk/webafx";
import type { PinoLoggerProvider } from "blendsdk/webafx-pino";
import express, { type Express } from "express";
import helmet from "helmet";
import type { OpenVaultConfig } from "../config/index.js";
import {
  CidrMatcher,
  isLoopbackPeer,
  normalizePeerAddress,
  usesBroadProxyDefault,
} from "./proxy.js";
import {
  createScopeMiddleware,
  type ListenerKind,
  listenerOf,
  markListener,
  normalizeRequestPath,
} from "./scope.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GLOBAL_BODY_LIMIT = 131_072;
const SECRET_BODY_LIMIT = 65_536;

function correlationMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const inbound = req.headers["x-request-id"];
  const requestId =
    typeof inbound === "string" && UUID_PATTERN.test(inbound) ? inbound : randomUUID();

  req.id = requestId;
  req.headers["x-request-id"] = requestId;
  res.setHeader("X-Request-ID", requestId);
  next();
}

function stripAgentForwardedHeadersMiddleware(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
): void {
  if (listenerOf(req) !== "admin") {
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-forwarded-proto"];
    delete req.headers["x-forwarded-host"];
    delete req.headers["x-real-ip"];
    delete req.headers.forwarded;
  }
  next();
}

function noStoreMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  try {
    const path = normalizeRequestPath(req.originalUrl || req.url);
    if (path === "/v1" || path.startsWith("/v1/")) {
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  } catch (error) {
    next(error);
  }
}

function sourceGuardMiddleware(matcher: CidrMatcher): express.RequestHandler {
  return (req, _res, next) => {
    if (listenerOf(req) !== "admin") {
      next();
      return;
    }

    let path: string;
    try {
      path = normalizeRequestPath(req.originalUrl || req.url);
    } catch (error) {
      next(error);
      return;
    }

    const peer = normalizePeerAddress(req.socket.remoteAddress);
    if (isLoopbackPeer(peer)) {
      if (path === "/health" || path === "/ready") {
        next();
        return;
      }
      next(new ForbiddenError("Direct admin access is not allowed"));
      return;
    }

    if (matcher.contains(peer)) {
      next();
      return;
    }
    next(new ForbiddenError("Direct admin access is not allowed"));
  };
}

function mediaTypeGuardMiddleware(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
): void {
  try {
    const path = normalizeRequestPath(req.originalUrl || req.url);
    if (path !== "/v1" && !path.startsWith("/v1/")) {
      next();
      return;
    }

    const hasBody =
      (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0") ||
      req.headers["transfer-encoding"] !== undefined;
    if (!hasBody) {
      next();
      return;
    }

    const contentType = req.headers["content-type"]?.toLowerCase() ?? "";
    const isJson =
      contentType.startsWith("application/json") ||
      /^application\/[^;]+\+json(?:;|$)/.test(contentType);
    if (!isJson) {
      next(new ApiError(415, "unsupported_media_type", "Use application/json"));
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}

function contentLengthGuardMiddleware(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
): void {
  try {
    const path = normalizeRequestPath(req.originalUrl || req.url);
    const limit =
      path === "/v1/secrets" || path.startsWith("/v1/secrets/")
        ? SECRET_BODY_LIMIT
        : GLOBAL_BODY_LIMIT;
    const header = req.headers["content-length"];
    if (header !== undefined) {
      const length = Number(header);
      if (Number.isFinite(length) && length > limit) {
        next(new ApiError(413, "payload_too_large", "Payload too large"));
        return;
      }
    }
    next();
  } catch (error) {
    next(error);
  }
}

function jsonParserMiddleware(): express.RequestHandler {
  return express.json({
    limit: "128kb",
    verify: (req, _res, buffer) => {
      const path = normalizeRequestPath(req.url);
      const limit =
        path === "/v1/secrets" || path.startsWith("/v1/secrets/")
          ? SECRET_BODY_LIMIT
          : GLOBAL_BODY_LIMIT;
      if (buffer.length > limit) {
        throw new ApiError(413, "payload_too_large", "Payload too large");
      }
    },
  });
}

function bodyParserErrorType(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const type = Reflect.get(error, "type");
  return typeof type === "string" ? type : undefined;
}

function bodyParserErrorMapper(
  error: unknown,
  _req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
): void {
  if (typeof error === "object" && error !== null) {
    // body-parser attaches the raw request bytes to its thrown error.
    Reflect.deleteProperty(error, "body");
  }
  if (error instanceof ApiError) {
    next(error);
    return;
  }
  const type = bodyParserErrorType(error);
  if (type === "entity.too.large") {
    next(new ApiError(413, "payload_too_large", "Payload too large"));
    return;
  }
  if (type === "entity.parse.failed") {
    next(new ApiError(400, "invalid_json", "Invalid JSON"));
    return;
  }
  next(error);
}

function errorStatusAndCode(error: unknown): { statusCode: number; code: string } {
  if (error instanceof ApiError) {
    return { statusCode: error.statusCode, code: error.code };
  }
  return { statusCode: 500, code: "INTERNAL_SERVER_ERROR" };
}

function logPath(req: express.Request): string {
  try {
    return normalizeRequestPath(req.originalUrl || req.url);
  } catch {
    return req.path;
  }
}

function preStackErrorLogger(
  provider: PinoLoggerProvider,
): (
  error: unknown,
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => void {
  return (error, req, _res, next) => {
    if (!req.services) {
      const { statusCode, code } = errorStatusAndCode(error);
      void provider.warn("request rejected", {
        requestId: req.id,
        method: req.method,
        path: logPath(req),
        statusCode,
        code,
      });
    }
    next(error);
  };
}

/** Test-only pre-stack options. Production callers leave this empty. */
export interface PreStackOptions {
  /**
   * Marks requests that did not arrive through an HTTPS wrapper.
   *
   * Supertest calls the Express application directly, so it cannot set the
   * listener marker the way the real servers do. Production never sets this.
   */
  readonly testListener?: ListenerKind;
}

/**
 * Installs the pre-routing boundary on the Express application.
 *
 * The middleware runs before WebAFX's core parsers, so scope, source, header,
 * media-type, and body-size decisions happen before any route or service code.
 * WebAFX remains the single response-envelope renderer.
 *
 * @param app - Express application owned by the WebAFX instance.
 * @param config - Validated runtime configuration.
 * @param provider - Shared pino provider for the pre-stack rejection log.
 * @param options - Test-only listener marker; production leaves it empty.
 */
export function installPreStack(
  app: Express,
  config: OpenVaultConfig,
  provider: PinoLoggerProvider,
  options: PreStackOptions = {},
): void {
  const matcher = new CidrMatcher(config.proxyCidrs);

  if (options.testListener !== undefined) {
    const listener = options.testListener;
    app.use((req, _res, next) => {
      if (listenerOf(req) === undefined) {
        markListener(req, listener);
      }
      next();
    });
  }

  app.use(correlationMiddleware);
  app.use(stripAgentForwardedHeadersMiddleware);
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(noStoreMiddleware);
  app.use(createScopeMiddleware());
  app.use(sourceGuardMiddleware(matcher));
  app.use(mediaTypeGuardMiddleware);
  app.use(contentLengthGuardMiddleware);
  app.use(jsonParserMiddleware());
  app.use(bodyParserErrorMapper);
  app.use(preStackErrorLogger(provider));

  if (config.envMode === "production" && usesBroadProxyDefault(config.proxyCidrs)) {
    void provider.warn("broad proxy CIDR default is in use", {
      variable: "OPENVAULT_PROXY_CIDRS",
      recommendation: "Pin the proxy address in the reference Compose stack",
    });
  }
}
