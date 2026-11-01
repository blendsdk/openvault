import { createHash } from "node:crypto";
import { rateLimitMiddleware } from "blendsdk/webafx";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { normalizeIdentifier } from "./local-login.js";

const LOGIN_WINDOW_MS = 60_000;
const ACCOUNT_WINDOW_MS = 3_600_000;
const REFRESH_WINDOW_MS = 60_000;

/**
 * Builds the per-account rate-limit key.
 *
 * The normalized identifier is hashed so the in-memory limiter never stores an
 * email address. The same function is used by browser and CLI login.
 *
 * @param identifier - Raw request identifier, if present.
 * @returns A stable `account:<sha256>` key.
 */
export function accountRateKey(identifier: unknown): string {
  const normalized = typeof identifier === "string" ? normalizeIdentifier(identifier) : "";
  return `account:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

/** The shared login and refresh limiter instances for one application. */
export interface AuthRateLimitService {
  /** Five login attempts per minute per client address. */
  readonly loginIp: RequestHandler;
  /** Ten login attempts per hour per normalized account. */
  readonly loginAccount: RequestHandler;
  /** Sixty refresh attempts per minute per client address. */
  readonly refreshIp: RequestHandler;
  /**
   * Consume the per-family refresh bucket after a token lookup.
   *
   * @param familyId - Family resolved from the refresh-token hash.
   * @param req - Express request.
   * @param res - Express response, used for rate-limit headers.
   * @returns A promise that resolves when the request may continue.
   */
  consumeRefreshFamily(familyId: string, req: Request, res: Response): Promise<void>;
}

/**
 * Creates one set of limiter instances for an application.
 *
 * The browser and CLI login routes must receive these exact middleware
 * objects. Creating a second set would create a second set of in-memory
 * buckets and break the shared-limit guarantee.
 *
 * @returns The shared limiter service.
 */
export function createAuthRateLimitService(): AuthRateLimitService {
  const loginIp = rateLimitMiddleware({
    maxRequests: 5,
    windowMs: LOGIN_WINDOW_MS,
  });
  const loginAccount = rateLimitMiddleware({
    maxRequests: 10,
    windowMs: ACCOUNT_WINDOW_MS,
    keyExtractor: (req) => accountRateKey(req.body?.identifier),
  });
  const refreshIp = rateLimitMiddleware({
    maxRequests: 60,
    windowMs: REFRESH_WINDOW_MS,
  });
  const refreshFamily = rateLimitMiddleware({
    maxRequests: 30,
    windowMs: REFRESH_WINDOW_MS,
    keyExtractor: (req) => req.cliRefreshFamilyId ?? "family:unknown",
  });

  return {
    loginIp,
    loginAccount,
    refreshIp,
    consumeRefreshFamily(familyId: string, req: Request, res: Response): Promise<void> {
      req.cliRefreshFamilyId = familyId;
      return new Promise<void>((resolve, reject) => {
        try {
          refreshFamily(req, res, (error?: unknown) => {
            if (error !== undefined) {
              reject(error);
              return;
            }
            resolve();
          });
        } catch (error) {
          reject(error);
        }
      });
    },
  };
}

type SharedLimiterName = "loginIp" | "loginAccount" | "refreshIp";

function resolveLimiter(name: SharedLimiterName): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    req.services
      .get<AuthRateLimitService>("authRateLimits")
      .then((limits) => limits[name](req, res, next))
      .catch(next);
  };
}

/**
 * Applies the shared per-address login limit.
 *
 * The wrapper resolves the application-scoped limiter at request time because
 * WebAFX route definitions are synchronous while the service container is not.
 *
 * @returns An Express middleware.
 */
export function loginIpLimit(): RequestHandler {
  return resolveLimiter("loginIp");
}

/**
 * Applies the shared per-account login limit.
 *
 * @returns An Express middleware.
 */
export function loginAccountLimit(): RequestHandler {
  return resolveLimiter("loginAccount");
}

/**
 * Applies the shared per-address refresh limit.
 *
 * @returns An Express middleware.
 */
export function refreshIpLimit(): RequestHandler {
  return resolveLimiter("refreshIp");
}
