import {
  refreshResponseSchema,
  sessionListSchema,
  sessionResponseSchema,
} from "@openvault/api-contract";
import type { RouteDefinition } from "blendsdk/webafx";
import { ApiError, BaseController, NotFoundError } from "blendsdk/webafx";
import type { Request, Response } from "express";
import { clearSessionCookie, readSessionCookie, setSessionCookie } from "../auth/cookie.js";
import { requireSession } from "../auth/middleware.js";
import type { SessionRecord, SessionService } from "../auth/sessions.js";

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

/** Remaining cookie lifetime in seconds, rounded up and never negative. */
function remainingSeconds(record: SessionRecord): number {
  return Math.max(0, Math.ceil((record.expiresAt - Date.now()) / 1_000));
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
    return [
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
          requireSession(req);
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

          setSessionCookie(res, rotated.secretId, remainingSeconds(rotated.record));
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
              sessions: records.map((record) => toSessionEntry(record, auth.session.publicId)),
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
