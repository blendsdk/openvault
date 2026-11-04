import { rateLimitMiddleware } from "blendsdk/webafx";
import type { NextFunction, Request, RequestHandler, Response } from "express";

const WINDOW_MS = 60_000;

/** Per-application audit endpoint limiters. */
export interface AuditRateLimitService {
  /** Event query limit. */
  readonly events: RequestHandler;
  /** Chain verification limit. */
  readonly verify: RequestHandler;
  /** NDJSON export limit. */
  readonly export: RequestHandler;
}

/** Test-only threshold overrides. */
export interface AuditRateLimitOptions {
  /** Event list requests per minute per principal. */
  readonly eventLimit?: number;
  /** Verify requests per minute per principal. */
  readonly verifyLimit?: number;
  /** Export requests per minute per principal. */
  readonly exportLimit?: number;
}

/** Uses the authenticated principal, never a forwarded header. */
function principalKey(req: Request): string {
  return `principal:${req.auth?.user.id ?? "anonymous"}`;
}

/**
 * Creates one set of audit limiter instances for an application.
 *
 * @param options - Test-only threshold overrides; production leaves this empty.
 * @returns The shared limiter service.
 */
export function createAuditRateLimitService(
  options: AuditRateLimitOptions = {},
): AuditRateLimitService {
  return {
    events: rateLimitMiddleware({
      maxRequests: options.eventLimit ?? 60,
      windowMs: WINDOW_MS,
      keyExtractor: principalKey,
    }),
    verify: rateLimitMiddleware({
      maxRequests: options.verifyLimit ?? 10,
      windowMs: WINDOW_MS,
      keyExtractor: principalKey,
    }),
    export: rateLimitMiddleware({
      maxRequests: options.exportLimit ?? 5,
      windowMs: WINDOW_MS,
      keyExtractor: principalKey,
    }),
  };
}

type AuditLimiterName = keyof AuditRateLimitService;

/** Resolves one limiter from the application container. */
function resolveLimiter(name: AuditLimiterName): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    req.services
      .get<AuditRateLimitService>("auditRateLimits")
      .then((limits) => limits[name](req, res, next))
      .catch(next);
  };
}

/**
 * Applies the event query limit.
 *
 * @returns An Express middleware.
 */
export function auditEventLimit(): RequestHandler {
  return resolveLimiter("events");
}

/**
 * Applies the verification limit.
 *
 * @returns An Express middleware.
 */
export function auditVerifyLimit(): RequestHandler {
  return resolveLimiter("verify");
}

/**
 * Applies the export limit.
 *
 * @returns An Express middleware.
 */
export function auditExportLimit(): RequestHandler {
  return resolveLimiter("export");
}
