import { cliLoginRequestSchema, cliTokenResponseSchema } from "@openvault/api-contract";
import type { RouteDefinition } from "blendsdk/webafx";
import { ApiError, BaseController } from "blendsdk/webafx";
import type { Request, Response } from "express";
import type { CliAuthService } from "../auth/cli-auth-service.js";
import { normalizeUserAgent } from "../auth/cli-sessions.js";
import type { LocalLoginService } from "../auth/local-login.js";
import { loginAccountLimit, loginIpLimit } from "../auth/login-rate-limits.js";

/** Builds the one generic local-credential failure. */
function invalidCredentials(): ApiError {
  return new ApiError(401, "invalid_credentials", "Invalid credentials");
}

/**
 * Command-line authentication routes.
 *
 * Login is public and shares the browser verifier and limiter buckets. The
 * remaining routes are added by the refresh and session phases; they all use a
 * bearer context and never set a browser cookie.
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

          const userAgentHeader = req.headers["user-agent"];
          const issued = await cliAuth.login(result.credential, {
            ip: req.ip ?? null,
            userAgent: normalizeUserAgent(
              typeof userAgentHeader === "string" ? userAgentHeader : undefined,
            ),
          });
          if (issued.kind === "credential_changed") {
            throw invalidCredentials();
          }

          this.ok(res, cliTokenResponseSchema.parse(issued.response));
        }),
    ];
  }
}
