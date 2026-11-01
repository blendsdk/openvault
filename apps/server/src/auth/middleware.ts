import { ApiError } from "blendsdk/webafx";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { SigningKeyService } from "../security/signing-keys.js";
import { normalizeRequestPath } from "../transport/scope.js";
import { CliTokenError } from "./cli-jwt.js";
import type { CliSessionRepository } from "./cli-sessions.js";
import { clearSessionCookie, readSessionCookie } from "./cookie.js";
import type {
  AuthContext,
  BrowserAuthContext,
  CliAuthContext,
  PrincipalStatus,
  SessionRecord,
} from "./types.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Session operations needed by the request middleware. */
export interface SessionLookup {
  /** Resolves a session by secret cookie value. */
  get(secretId: string): Promise<SessionRecord | undefined>;
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
 * Requests without a session cookie pass through unauthenticated. Any
 * Authorization header also suppresses cookie resolution, so an invalid CLI
 * bearer can never fall back to a browser session. A stale, expired, or
 * disabled-principal session clears the cookie and, for a disabled principal,
 * revokes the stored session.
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
      if (req.auth !== undefined || req.headers.authorization !== undefined) {
        // A CLI context wins. An invalid Authorization header must never fall
        // back to a browser cookie; the protected route returns 401 instead.
        next();
        return;
      }

      const secretId = readSessionCookie(req);
      if (secretId === undefined) {
        next();
        return;
      }

      const session = await sessions.get(secretId);
      if (session === undefined) {
        // Do not clear the cookie here: a stale request may resolve after a
        // concurrent rotation and would otherwise delete the fresh cookie.
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
        kind: "browser",
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
 * Resolves an optional CLI bearer token and attaches a CLI context.
 *
 * A missing or malformed header leaves the request unauthenticated. A
 * well-formed token is verified and then checked against the principal status
 * and a live family row. Invalid tokens do not throw: the protected route's
 * helper returns 401. A keyring or database failure propagates as an error.
 *
 * @param signingKeys - Current/previous JWT verifier.
 * @param sessions - CLI family repository.
 * @returns Express middleware.
 */
export function cliAuthMiddleware(
  signingKeys: SigningKeyService,
  sessions: CliSessionRepository,
): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (typeof header !== "string") {
      next();
      return;
    }

    const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
    const token = match?.[1];
    if (token === undefined) {
      next();
      return;
    }

    try {
      const claims = await signingKeys.verifyAccessToken(token);
      const principal = await sessions.findActiveContext(claims.sub, claims.sid);
      if (principal === undefined) {
        next();
        return;
      }

      req.auth = {
        kind: "cli",
        principalId: principal.principalId,
        familyId: claims.sid,
        jti: claims.jti,
        expiresAt: claims.exp * 1_000,
        user: {
          id: principal.principalId,
          name: principal.name,
          email: principal.email,
          authMethod: "local",
        },
        mustChangePassword: principal.mustChange,
      };
      next();
    } catch (error) {
      if (error instanceof CliTokenError) {
        next();
        return;
      }
      next(error);
    }
  };
}

/**
 * Requires an authenticated browser session.
 *
 * @param req - Express request.
 * @returns The attached browser context.
 * @throws {ApiError} 401 when the request has no valid browser session.
 */
export function requireSession(req: Request): BrowserAuthContext {
  if (req.auth?.kind !== "browser") {
    throw new ApiError(401, "authentication_required", "Authentication required");
  }
  return req.auth;
}

/**
 * Requires an authenticated CLI context.
 *
 * @param req - Express request.
 * @returns The attached CLI context.
 * @throws {ApiError} 401 when the request has no valid CLI credential.
 */
export function requireCli(req: Request): CliAuthContext {
  if (req.auth?.kind !== "cli") {
    throw new ApiError(401, "authentication_required", "Authentication required");
  }
  return req.auth;
}

/**
 * Requires either a browser or CLI context.
 *
 * Data routes that both callers share use this helper. Browser-only routes
 * use {@link requireSession}; CLI-only routes use {@link requireCli}.
 *
 * @param req - Express request.
 * @returns The attached context.
 * @throws {ApiError} 401 when the request is unauthenticated.
 */
export function requirePrincipal(req: Request): AuthContext {
  if (req.auth === undefined) {
    throw new ApiError(401, "authentication_required", "Authentication required");
  }
  return req.auth;
}

/**
 * Blocks authenticated routes while a forced password change is pending.
 *
 * Browser contexts allow `GET /v1/auth/me`, `POST /v1/auth/password`,
 * `POST /v1/auth/logout`, and `GET /v1/meta`. CLI contexts allow
 * `GET /v1/auth/cli/me` and logout. Logout remains available because it
 * authorizes on the refresh token. Unauthenticated requests pass through so
 * public routes and their own authentication checks still work.
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
        req.auth.kind === "browser"
          ? (method === "GET" && path === "/v1/auth/me") ||
            (method === "POST" && path === "/v1/auth/password") ||
            (method === "POST" && path === "/v1/auth/logout") ||
            (method === "GET" && (path === "/v1/meta" || path.startsWith("/v1/meta/")))
          : (method === "GET" && path === "/v1/auth/cli/me") ||
            (method === "POST" && path === "/v1/auth/cli/logout");

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
