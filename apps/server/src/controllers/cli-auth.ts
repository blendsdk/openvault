import {
  cliLoginRequestSchema,
  cliLogoutRequestSchema,
  cliMeResponseSchema,
  cliRefreshRequestSchema,
  cliSessionListSchema,
  cliTokenResponseSchema,
  ulidSchema,
} from "@openvault/api-contract";
import type { RouteDefinition } from "blendsdk/webafx";
import { ApiError, BaseController } from "blendsdk/webafx";
import type { Request, Response } from "express";
import type { CliAuthService } from "../auth/cli-auth-service.js";
import {
  type CliRequestContext,
  type CliSessionRepository,
  hashRefreshToken,
  normalizeUserAgent,
} from "../auth/cli-sessions.js";
import type { LocalLoginService } from "../auth/local-login.js";
import {
  type AuthRateLimitService,
  loginAccountLimit,
  loginIpLimit,
  refreshIpLimit,
} from "../auth/login-rate-limits.js";
import { requireCli } from "../auth/middleware.js";

/** Builds the one generic local-credential failure. */
function invalidCredentials(): ApiError {
  return new ApiError(401, "invalid_credentials", "Invalid credentials");
}

/** Builds the one generic refresh-token failure. */
function invalidRefreshToken(): ApiError {
  return new ApiError(401, "invalid_refresh_token", "Invalid refresh token");
}

/** Builds the stable missing-family response. */
function sessionNotFound(): ApiError {
  return new ApiError(404, "session_not_found", "Session not found");
}

/** Reads the login context stored on a new refresh row. */
function requestContext(req: Request): CliRequestContext {
  const header = req.headers["user-agent"];
  return {
    ip: req.ip ?? null,
    userAgent: normalizeUserAgent(typeof header === "string" ? header : undefined),
  };
}

/**
 * Command-line authentication routes.
 *
 * Login is public and shares the browser verifier and limiter buckets. Refresh,
 * logout, and session-management routes use a bearer or refresh-token context
 * and never set a browser cookie.
 */
export class CliAuthController extends BaseController {
  /** @inheritDoc */
  public routes(): RouteDefinition[] {
    return [
      this.route()
        .post("/login")
        .middleware(loginIpLimit())
        .middleware(loginAccountLimit())
        .handle(async (req: Request, res: Response) => {
          const parsed = cliLoginRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(400, "validation_error", "Validation failed");
          }

          const localLogin = await this.services.get<LocalLoginService>("localLogin");
          const cliAuth = await this.services.get<CliAuthService>("cliAuth");
          const result = await localLogin.login(parsed.data, req.log);
          if (!result.ok) {
            throw invalidCredentials();
          }

          const issued = await cliAuth.login(result.credential, requestContext(req));
          if (issued.kind === "credential_changed") {
            throw invalidCredentials();
          }

          this.ok(res, cliTokenResponseSchema.parse(issued.response));
        }),
      this.route()
        .post("/refresh")
        .middleware(refreshIpLimit())
        .handle(async (req: Request, res: Response) => {
          const parsed = cliRefreshRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(400, "validation_error", "Validation failed");
          }

          const refreshHash = hashRefreshToken(parsed.data.refreshToken);
          const sessions = await this.services.get<CliSessionRepository>("cliSessions");
          const family = await sessions.findFamilyByHash(refreshHash);
          if (family === undefined) {
            throw invalidRefreshToken();
          }

          const limits = await this.services.get<AuthRateLimitService>("authRateLimits");
          await limits.consumeRefreshFamily(family.familyId, req, res);

          const cliAuth = await this.services.get<CliAuthService>("cliAuth");
          const result = await cliAuth.refresh(
            refreshHash,
            family.principalId,
            family.familyId,
            requestContext(req),
          );
          if (result.kind !== "issued") {
            throw invalidRefreshToken();
          }

          this.ok(res, cliTokenResponseSchema.parse(result.response));
        }),
      this.route()
        .post("/logout")
        .handle(async (req: Request, res: Response) => {
          const parsed = cliLogoutRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(400, "validation_error", "Validation failed");
          }

          const cliAuth = await this.services.get<CliAuthService>("cliAuth");
          await cliAuth.logout(hashRefreshToken(parsed.data.refreshToken));
          this.noContent(res);
        }),
      this.route()
        .get("/me")
        .handle(async (req: Request, res: Response) => {
          const auth = requireCli(req);
          this.ok(
            res,
            cliMeResponseSchema.parse({
              user: auth.user,
              mustChangePassword: auth.mustChangePassword,
            }),
          );
        }),
      this.route()
        .get("/sessions")
        .handle(async (req: Request, res: Response) => {
          const auth = requireCli(req);
          const sessions = await this.services.get<CliSessionRepository>("cliSessions");
          const families = await sessions.listFamilies(auth.principalId);
          this.ok(
            res,
            cliSessionListSchema.parse({
              sessions: families.map((family) => ({
                id: family.familyId,
                createdAt: family.createdAt.toISOString(),
                expiresAt: family.expiresAt.toISOString(),
                current: family.familyId === auth.familyId,
              })),
            }),
          );
        }),
      this.route()
        .delete("/sessions/:familyId")
        .handle(async (req: Request, res: Response) => {
          const auth = requireCli(req);
          const familyId = req.params.familyId;
          if (typeof familyId !== "string" || !ulidSchema.safeParse(familyId).success) {
            throw sessionNotFound();
          }

          const sessions = await this.services.get<CliSessionRepository>("cliSessions");
          if (!(await sessions.revokeOwnedFamily(familyId, auth.principalId))) {
            throw sessionNotFound();
          }
          this.noContent(res);
        }),
    ];
  }
}
