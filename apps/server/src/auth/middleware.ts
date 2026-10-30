import { ApiError } from "blendsdk/webafx";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { normalizeRequestPath } from "../transport/scope.js";
import { clearSessionCookie, readSessionCookie } from "./cookie.js";
import type { AuthContext, PrincipalStatus, SessionRecord } from "./types.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Session operations needed by the request middleware. */
export interface SessionLookup {
  /** Resolves a session by secret cookie value. */
  get(secretId: string): Promise<SessionRecord | undefined>;
  /** Reports whether an old secret has a live rotation receipt. */
  hasRecentRotation(secretId: string): boolean;
  /** Revokes one session owned by the principal. */
  revoke(publicId: string, principalId: string): Promise<boolean>;
}

/** Principal status lookup needed by the request middleware. */
export interface PrincipalLookup {
  /** Loads status and forced-change state for a principal. */
  findStatus(principalId: string): Promise<PrincipalStatus | undefined>;
}

/**
 * Resolves a browser session and attaches the authenticated context.
 *
 * Requests without a session cookie pass through unauthenticated. A stale,
 * expired, or disabled-principal session clears the cookie and, for a disabled
 * principal, revokes the stored session.
 *
 * @param sessions - Session store.
 * @param credentials - Principal status repository.
 * @returns Express middleware.
 */
export function sessionMiddleware(
  sessions: SessionLookup,
  credentials: PrincipalLookup,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const secretId = readSessionCookie(req);
      if (secretId === undefined) {
        next();
        return;
      }

      const session = await sessions.get(secretId);
      if (session === undefined) {
        if (!sessions.hasRecentRotation(secretId)) {
          clearSessionCookie(res);
        }
        next();
        return;
      }

      const status = await credentials.findStatus(session.principalId);
      if (status === undefined || status.status !== "active") {
        await sessions.revoke(session.publicId, session.principalId);
        clearSessionCookie(res);
        next();
        return;
      }

      req.auth = {
        session,
        user: {
          id: session.principalId,
          name: status.name,
          email: status.email,
          authMethod: session.authMethod,
        },
        mustChangePassword: status.mustChange,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Requires an authenticated session.
 *
 * @param req - Express request.
 * @returns The attached authentication context.
 * @throws {ApiError} 401 when the request has no valid session.
 */
export function requireSession(req: Request): AuthContext {
  if (req.auth === undefined) {
    throw new ApiError(401, "authentication_required", "Authentication required");
  }
  return req.auth;
}

/**
 * Blocks authenticated routes while a forced password change is pending.
 *
 * Only `GET /v1/auth/me`, `POST /v1/auth/password`, `POST /v1/auth/logout`,
 * and `GET /v1/meta` or `GET /v1/meta/*` are allowed. Unauthenticated requests
 * pass through so public routes and their own authentication checks still work.
 *
 * @returns Express middleware.
 */
export function passwordChangeGate(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (req.auth === undefined || !req.auth.mustChangePassword) {
        next();
        return;
      }

      const path = normalizeRequestPath(req.originalUrl || req.url);
      const method = (req.method ?? "GET").toUpperCase();
      const allowed =
        (method === "GET" && path === "/v1/auth/me") ||
        (method === "POST" && path === "/v1/auth/password") ||
        (method === "POST" && path === "/v1/auth/logout") ||
        (method === "GET" && (path === "/v1/meta" || path.startsWith("/v1/meta/")));

      if (allowed) {
        next();
        return;
      }
      next(new ApiError(403, "password_change_required", "Password change required"));
    } catch (error) {
      next(error);
    }
  };
}

/** Reports whether a method is safe for CSRF purposes. */
export function isSafeMethod(method: string | undefined): boolean {
  return SAFE_METHODS.has((method ?? "GET").toUpperCase());
}
