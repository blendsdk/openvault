import { ApiError, csrfMiddleware } from "blendsdk/webafx";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { OpenVaultConfig } from "../config/index.js";
import { normalizeRequestPath } from "../transport/scope.js";
import { isSafeMethod } from "./middleware.js";

const LOCAL_LOGIN_PATH = "/v1/auth/local/login";
const CSRF_MESSAGE = "Invalid or missing CSRF token";

function csrfError(): ApiError {
  return new ApiError(403, "csrf_invalid", CSRF_MESSAGE);
}

/**
 * Enforces a same-origin browser context on cookie-authenticated mutations.
 *
 * The guard applies when a session is attached or when the request targets the
 * local login route (which establishes a session and has no context yet).
 * Bearer and mTLS routes without a session pass through to their own
 * authentication. If `Origin` is present it must match the configured origin;
 * otherwise `Sec-Fetch-Site` must be `same-origin`.
 *
 * @param config - Validated runtime configuration.
 * @returns Express middleware.
 */
export function originGuard(config: OpenVaultConfig): RequestHandler {
  const expectedOrigin = config.baseUrl.origin;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (isSafeMethod(req.method)) {
      next();
      return;
    }

    let isLogin = false;
    try {
      isLogin = normalizeRequestPath(req.originalUrl || req.url) === LOCAL_LOGIN_PATH;
    } catch (error) {
      next(error);
      return;
    }

    if (req.auth === undefined && !isLogin) {
      next();
      return;
    }

    const origin = req.headers.origin;
    if (typeof origin === "string") {
      if (origin !== expectedOrigin) {
        next(csrfError());
        return;
      }
      next();
      return;
    }

    const fetchSite = req.headers["sec-fetch-site"];
    if (typeof fetchSite === "string" && fetchSite.toLowerCase() === "same-origin") {
      next();
      return;
    }
    next(csrfError());
  };
}

/**
 * Applies the WebAFX CSRF token check only to authenticated browser requests.
 *
 * The session middleware must run first. Requests without a resolved context
 * (bearer, mTLS, or unauthenticated) pass through; their route authentication
 * decides the response. The expected token is the current session's CSRF value.
 *
 * @returns Express middleware.
 */
export function csrfGuard(): RequestHandler {
  const check = csrfMiddleware({
    expectedToken: (req) => req.auth?.session.csrfToken,
  });

  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.auth === undefined) {
      next();
      return;
    }
    await check(req, res, next);
  };
}
