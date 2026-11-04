import { rateLimitMiddleware } from "blendsdk/webafx";
import type { NextFunction, Request, RequestHandler, Response } from "express";

const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 600;

/** Per-application data-plane limiter. */
export interface SecretRateLimitService {
  /** The shared `/v1/data` middleware. */
  readonly middleware: RequestHandler;
}

/** Test-only threshold override. */
export interface SecretRateLimitOptions {
  /** Requests per minute per principal. */
  readonly limit?: number;
}

/** Uses the agent principal or the authenticated user, never a header. */
function principalKey(req: Request): string {
  return `data:${req.agent?.principalId ?? req.auth?.user.id ?? "anonymous"}`;
}

/**
 * Creates one data-plane limiter for an application.
 *
 * @param options - Test-only threshold override.
 * @returns The limiter service.
 */
export function createSecretRateLimitService(
  options: SecretRateLimitOptions = {},
): SecretRateLimitService {
  return {
    middleware: rateLimitMiddleware({
      maxRequests: options.limit ?? DEFAULT_LIMIT,
      windowMs: WINDOW_MS,
      keyExtractor: principalKey,
    }),
  };
}

/**
 * Resolves the application's data-plane limiter.
 *
 * @returns An Express middleware.
 */
export function secretRateLimit(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    req.services
      .get<SecretRateLimitService>("secretRateLimits")
      .then((limits) => limits.middleware(req, res, next))
      .catch(next);
  };
}
