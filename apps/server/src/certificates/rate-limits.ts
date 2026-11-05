import { rateLimitMiddleware } from "blendsdk/webafx";
import type { NextFunction, Request, RequestHandler, Response } from "express";

const WINDOW_MS = 60_000;
const WRITE_LIMIT = 10;
const PRIVATE_READ_LIMIT = 30;

/** Per-application certificate limiters. */
export interface CertificateRateLimitService {
  /** Import/generate limiter. */
  readonly write: RequestHandler;
  /** Private-key read limiter. */
  readonly privateKey: RequestHandler;
}

/** Test-only threshold overrides. */
export interface CertificateRateLimitOptions {
  /** Import/generate requests per minute. */
  readonly writeLimit?: number;
  /** Private-key reads per minute. */
  readonly privateKeyLimit?: number;
}

/** Uses the authenticated user id, never a header or an agent principal. */
function principalKey(req: Request): string {
  return `certificate:${req.auth?.user.id ?? "anonymous"}`;
}

/**
 * Creates one write limiter and one private-read limiter for an application.
 *
 * @param options - Test-only threshold overrides.
 * @returns The limiter service.
 */
export function createCertificateRateLimitService(
  options: CertificateRateLimitOptions = {},
): CertificateRateLimitService {
  return {
    write: rateLimitMiddleware({
      maxRequests: options.writeLimit ?? WRITE_LIMIT,
      windowMs: WINDOW_MS,
      keyExtractor: principalKey,
    }),
    privateKey: rateLimitMiddleware({
      maxRequests: options.privateKeyLimit ?? PRIVATE_READ_LIMIT,
      windowMs: WINDOW_MS,
      keyExtractor: principalKey,
    }),
  };
}

/**
 * Resolves the import/generate limiter.
 *
 * @returns An Express middleware.
 */
export function certificateWriteRateLimit(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    req.services
      .get<CertificateRateLimitService>("certificateRateLimits")
      .then((limits) => limits.write(req, res, next))
      .catch(next);
  };
}

/**
 * Resolves the private-key read limiter.
 *
 * @returns An Express middleware.
 */
export function certificatePrivateKeyRateLimit(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    req.services
      .get<CertificateRateLimitService>("certificateRateLimits")
      .then((limits) => limits.privateKey(req, res, next))
      .catch(next);
  };
}
