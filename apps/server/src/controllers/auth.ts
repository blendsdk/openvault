import { createHash } from "node:crypto";
import {
  loginRequestSchema,
  passwordChangeRequestSchema,
  refreshResponseSchema,
  sessionListSchema,
  sessionResponseSchema,
} from "@openvault/api-contract";
import type { RouteDefinition } from "blendsdk/webafx";
import { ApiError, BaseController, NotFoundError, rateLimitMiddleware } from "blendsdk/webafx";
import type { Request, Response } from "express";
import { clearSessionCookie, readSessionCookie, setSessionCookie } from "../auth/cookie.js";
import type { CredentialsRepository } from "../auth/credentials.js";
import { requireSession } from "../auth/middleware.js";
import {
  dummyVerify,
  hashPassword,
  validateNewPassword,
  verifyPassword,
} from "../auth/password.js";
import type { SessionRecord, SessionService } from "../auth/sessions.js";

const LOGIN_WINDOW_MS = 60_000;
const ACCOUNT_WINDOW_MS = 3_600_000;
const PASSWORD_WINDOW_MS = 60_000;

/** Normalizes a login identifier before lookup and rate-limit keying. */
function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

/** Hashes the normalized identifier so the limiter never stores an email. */
function accountRateKey(value: unknown): string {
  const identifier = typeof value === "string" ? normalizeIdentifier(value) : "";
  return `account:${createHash("sha256").update(identifier, "utf8").digest("hex")}`;
}

/** Uses the public session id as the password-change rate-limit key. */
function sessionRateKey(req: Request): string {
  const publicId = req.auth?.session.publicId;
  return publicId === undefined ? "session:anonymous" : `session:${publicId}`;
}

/** Builds the one generic local-credential failure. */
function invalidCredentials(): ApiError {
  return new ApiError(401, "invalid_credentials", "Invalid credentials");
}

/** Reports whether a credential's lock is still active. */
function isLocked(lockedUntil: Date | null, now: number): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now;
}

/** Renders one session as the public list entry. */
function toSessionEntry(record: SessionRecord, currentPublicId: string) {
  return {
    id: record.publicId,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    authMethod: record.authMethod,
    current: record.publicId === currentPublicId,
  };
}

/**
 * Browser session routes.
 *
 * The session middleware attaches the authenticated context and the CSRF guard
 * protects unsafe mutations. This controller only renders the session state,
 * rotates it, revokes it, and lists it.
 */
export class AuthController extends BaseController {
  /** @inheritDoc */
  public routes(): RouteDefinition[] {
    const loginIpLimit = rateLimitMiddleware({
      maxRequests: 5,
      windowMs: LOGIN_WINDOW_MS,
    });
    const loginAccountLimit = rateLimitMiddleware({
      maxRequests: 10,
      windowMs: ACCOUNT_WINDOW_MS,
      keyExtractor: (req) => accountRateKey(req.body?.identifier),
    });
    const passwordIpLimit = rateLimitMiddleware({
      maxRequests: 10,
      windowMs: PASSWORD_WINDOW_MS,
    });
    const passwordSessionLimit = rateLimitMiddleware({
      maxRequests: 5,
      windowMs: PASSWORD_WINDOW_MS,
      keyExtractor: sessionRateKey,
    });

    return [
      this.route()
        .post("/local/login")
        .middleware(loginIpLimit)
        .middleware(loginAccountLimit)
        .handle(async (req: Request, res: Response) => {
          const parsed = loginRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(400, "validation_error", "Validation failed");
          }
          const input = parsed.data;
          const identifier = normalizeIdentifier(input.identifier);
          const credentials = await this.services.get<CredentialsRepository>("credentials");
          const sessions = await this.services.get<SessionService>("sessions");
          const credential = await credentials.findByIdentifier(identifier);
          const now = Date.now();

          if (credential === undefined) {
            await dummyVerify(input.password);
            throw invalidCredentials();
          }
          if (credential.status !== "active") {
            await dummyVerify(input.password);
            throw invalidCredentials();
          }
          if (isLocked(credential.lockedUntil, now)) {
            await dummyVerify(input.password);
            throw invalidCredentials();
          }
          if (!(await verifyPassword(input.password, credential.passwordHash))) {
            await credentials.recordFailure(credential.principalId);
            throw invalidCredentials();
          }

          await credentials.recordSuccess(credential.principalId);
          const issued = await sessions.create({
            principalId: credential.principalId,
            authMethod: "local",
          });
          setSessionCookie(res, issued.secretId, sessions.remainingSeconds(issued.record));
          this.ok(
            res,
            sessionResponseSchema.parse({
              user: {
                id: credential.principalId,
                name: credential.name,
                email: credential.email,
                authMethod: "local",
              },
              expiresAt: new Date(issued.record.expiresAt).toISOString(),
              csrfToken: issued.record.csrfToken,
              mustChangePassword: credential.mustChange,
              lastLoginAt: new Date(issued.record.createdAt).toISOString(),
            }),
          );
        }),
      this.route()
        .post("/password")
        .middleware(passwordIpLimit)
        .middleware(passwordSessionLimit)
        .handle(async (req: Request, res: Response) => {
          const auth = requireSession(req);
          const parsed = passwordChangeRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(400, "validation_error", "Validation failed");
          }
          const input = parsed.data;
          try {
            validateNewPassword(input.newPassword);
          } catch {
            throw new ApiError(400, "validation_error", "Invalid password");
          }

          const credentials = await this.services.get<CredentialsRepository>("credentials");
          const sessions = await this.services.get<SessionService>("sessions");
          const credential = await credentials.findByPrincipalId(auth.session.principalId);
          if (
            credential === undefined ||
            !(await verifyPassword(input.currentPassword, credential.passwordHash))
          ) {
            throw invalidCredentials();
          }

          const passwordHash = await hashPassword(input.newPassword);
          await credentials.changePassword(auth.session.principalId, passwordHash);

          const records = await sessions.list(auth.session.principalId);
          for (const record of records) {
            if (record.publicId !== auth.session.publicId) {
              await sessions.revoke(record.publicId, auth.session.principalId);
            }
          }

          const secretId = readSessionCookie(req);
          if (secretId === undefined) {
            clearSessionCookie(res);
            throw invalidCredentials();
          }
          const rotated = await sessions.rotate(secretId);
          if (rotated === undefined) {
            clearSessionCookie(res);
            throw invalidCredentials();
          }

          setSessionCookie(res, rotated.secretId, sessions.remainingSeconds(rotated.record));
          this.ok(
            res,
            refreshResponseSchema.parse({
              expiresAt: new Date(rotated.record.expiresAt).toISOString(),
              csrfToken: rotated.record.csrfToken,
            }),
          );
        }),
      this.route()
        .get("/me")
        .handle(async (req: Request, res: Response) => {
          const auth = requireSession(req);
          this.ok(
            res,
            sessionResponseSchema.parse({
              user: auth.user,
              expiresAt: new Date(auth.session.expiresAt).toISOString(),
              csrfToken: auth.session.csrfToken,
              mustChangePassword: auth.mustChangePassword,
              lastLoginAt: new Date(auth.session.createdAt).toISOString(),
            }),
          );
        }),
      this.route()
        .post("/refresh")
        .handle(async (req: Request, res: Response) => {
          const sessions = await this.services.get<SessionService>("sessions");
          const secretId = readSessionCookie(req);
          if (secretId === undefined) {
            clearSessionCookie(res);
            throw new ApiError(401, "authentication_required", "Authentication required");
          }

          const rotated = await sessions.rotate(secretId);
          if (rotated === undefined) {
            clearSessionCookie(res);
            throw new ApiError(401, "authentication_required", "Authentication required");
          }

          setSessionCookie(res, rotated.secretId, sessions.remainingSeconds(rotated.record));
          this.ok(
            res,
            refreshResponseSchema.parse({
              expiresAt: new Date(rotated.record.expiresAt).toISOString(),
              csrfToken: rotated.record.csrfToken,
            }),
          );
        }),
      this.route()
        .post("/logout")
        .handle(async (req: Request, res: Response) => {
          const auth = requireSession(req);
          const sessions = await this.services.get<SessionService>("sessions");
          await sessions.revoke(auth.session.publicId, auth.session.principalId);
          clearSessionCookie(res);
          this.noContent(res);
        }),
      this.route()
        .get("/sessions")
        .handle(async (req: Request, res: Response) => {
          const auth = requireSession(req);
          const sessions = await this.services.get<SessionService>("sessions");
          const records = await sessions.list(auth.session.principalId);
          this.ok(
            res,
            sessionListSchema.parse({
              sessions: [...records]
                .reverse()
                .map((record) => toSessionEntry(record, auth.session.publicId)),
            }),
          );
        }),
      this.route()
        .delete("/sessions/:id")
        .handle(async (req: Request, res: Response) => {
          const auth = requireSession(req);
          const sessions = await this.services.get<SessionService>("sessions");
          const publicId = req.params.id;
          if (typeof publicId !== "string" || publicId.length === 0) {
            throw new NotFoundError("Session not found");
          }
          const revoked = await sessions.revoke(publicId, auth.session.principalId);
          if (!revoked) {
            throw new NotFoundError("Session not found");
          }
          this.noContent(res);
        }),
    ];
  }
}
