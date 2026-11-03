import { rateLimitMiddleware } from "blendsdk/webafx";
import type { NextFunction, Request, RequestHandler, Response } from "express";

const WINDOW_MS = 60_000;
const WRITE_LIMIT = 30;
const READ_LIMIT = 60;

/** Per-application RBAC admin limiters. */
export interface RbacRateLimitService {
  /** Assignment create/delete limit. */
  readonly assignmentWrite: RequestHandler;
  /** Assignment list and access-explain limit. */
  readonly assignmentRead: RequestHandler;
}

/** Test-only threshold overrides. */
export interface RbacRateLimitOptions {
  /** Writes per minute per principal. */
  readonly writeLimit?: number;
  /** Reads per minute per principal. */
  readonly readLimit?: number;
}

/** Uses the authenticated principal, never a forwarded header. */
function principalKey(req: Request): string {
  return `principal:${req.auth?.user.id ?? "anonymous"}`;
}

/**
 * Creates one set of RBAC admin limiter instances for an application.
 *
 * @param options - Test-only threshold overrides; production leaves this empty.
 * @returns The shared limiter service.
 */
export function createRbacRateLimitService(
  options: RbacRateLimitOptions = {},
): RbacRateLimitService {
  return {
    assignmentWrite: rateLimitMiddleware({
      maxRequests: options.writeLimit ?? WRITE_LIMIT,
      windowMs: WINDOW_MS,
      keyExtractor: principalKey,
    }),
    assignmentRead: rateLimitMiddleware({
      maxRequests: options.readLimit ?? READ_LIMIT,
      windowMs: WINDOW_MS,
      keyExtractor: principalKey,
    }),
  };
}

type RbacLimiterName = keyof RbacRateLimitService;

function resolveLimiter(name: RbacLimiterName): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    req.services
      .get<RbacRateLimitService>("rbacRateLimits")
      .then((limits) => limits[name](req, res, next))
      .catch(next);
  };
}

/**
 * Applies the assignment write limit.
 *
 * @returns An Express middleware.
 */
export function assignmentWriteLimit(): RequestHandler {
  return resolveLimiter("assignmentWrite");
}

/**
 * Applies the assignment read limit.
 *
 * @returns An Express middleware.
 */
export function assignmentReadLimit(): RequestHandler {
  return resolveLimiter("assignmentRead");
}
