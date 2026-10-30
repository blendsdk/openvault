import { createHash } from "node:crypto";
import type { RouteDefinition } from "blendsdk/webafx";
import { ApiError, BaseController, rateLimitMiddleware } from "blendsdk/webafx";
import type { Request, Response } from "express";
import {
  clearOidcBindingCookie,
  readOidcBindingCookie,
  setOidcBindingCookie,
  setSessionCookie,
} from "../auth/cookie.js";
import { createOidcBinding, oidcBindingMatches } from "../auth/oidc/binding.js";
import type { OidcClient } from "../auth/oidc/client.js";
import {
  OidcAccessDeniedError,
  OidcFlowError,
  OidcLinkCollisionError,
  OidcUnavailableError,
} from "../auth/oidc/errors.js";
import type { OidcIdentityService } from "../auth/oidc/identity.js";
import { sanitizeReturnTo } from "../auth/oidc/return-to.js";
import type { OidcStateStore } from "../auth/oidc/state.js";
import type { SessionService } from "../auth/sessions.js";
import type { OpenVaultConfig } from "../config/index.js";
import type { OidcConfig } from "../config/types.js";

const OIDC_WINDOW_MS = 60_000;

/** Maps a typed OIDC failure to the public error envelope. */
function toOidcApiError(error: unknown): ApiError {
  if (error instanceof OidcFlowError) {
    return new ApiError(400, "oidc_callback_failed", "Sign-in failed");
  }
  if (error instanceof OidcUnavailableError) {
    return new ApiError(503, "oidc_unavailable", "Sign-in unavailable");
  }
  if (error instanceof OidcAccessDeniedError || error instanceof OidcLinkCollisionError) {
    return new ApiError(403, "access_denied", "Access denied");
  }
  return error instanceof ApiError
    ? error
    : new ApiError(500, "INTERNAL_SERVER_ERROR", "Internal error");
}

/**
 * OIDC login and callback routes.
 *
 * The controller stores only the PKCE verifier, nonce, and return path between
 * the redirect and the callback. Tokens are exchanged and discarded inside the
 * client; the browser receives only the opaque session cookie.
 */
export class OidcController extends BaseController {
  /** @inheritDoc */
  public routes(): RouteDefinition[] {
    const ipLimit = rateLimitMiddleware({
      maxRequests: 10,
      windowMs: OIDC_WINDOW_MS,
    });

    return [
      this.route()
        .get("/login")
        .middleware(ipLimit)
        .handle(async (req: Request, res: Response) => {
          await this.requireOidcConfig();
          const client = await this.services.get<OidcClient>("oidc");
          const states = await this.services.get<OidcStateStore>("oidcState");
          const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : undefined;
          const binding = createOidcBinding();

          let flow: Awaited<ReturnType<OidcClient["buildAuthorizationUrl"]>>;
          try {
            flow = await client.buildAuthorizationUrl(returnTo === undefined ? {} : { returnTo });
          } catch (error) {
            throw toOidcApiError(error);
          }

          await states.put(flow.state, {
            codeVerifier: flow.codeVerifier,
            nonce: flow.nonce,
            returnTo: flow.returnTo,
            bindingHash: binding.hash,
          });
          setOidcBindingCookie(res, binding.value);
          res.redirect(302, flow.url);
        }),
      this.route()
        .get("/callback")
        .middleware(ipLimit)
        .handle(async (req: Request, res: Response) => {
          const { oidc } = await this.requireOidcConfig();
          const client = await this.services.get<OidcClient>("oidc");
          const states = await this.services.get<OidcStateStore>("oidcState");
          const identities = await this.services.get<OidcIdentityService>("oidcIdentities");
          const sessions = await this.services.get<SessionService>("sessions");

          const stateParam = typeof req.query.state === "string" ? req.query.state : undefined;
          const code = typeof req.query.code === "string" ? req.query.code : undefined;
          if (stateParam === undefined || stateParam.length === 0) {
            throw new ApiError(400, "oidc_callback_failed", "Sign-in failed");
          }

          const state = await states.take(stateParam);
          if (state === undefined) {
            clearOidcBindingCookie(res);
            throw new ApiError(400, "oidc_callback_failed", "Sign-in failed");
          }
          if (!oidcBindingMatches(readOidcBindingCookie(req), state.bindingHash)) {
            clearOidcBindingCookie(res);
            throw new ApiError(400, "oidc_callback_failed", "Sign-in failed");
          }
          clearOidcBindingCookie(res);

          if (typeof req.query.error === "string") {
            const providerError = /^[a-z_]{1,64}$/.test(req.query.error)
              ? req.query.error
              : "invalid";
            await req.log?.warn("oidc_provider_error", { error: providerError });
            throw new ApiError(400, "oidc_callback_failed", "Sign-in failed");
          }
          if (code === undefined || code.length === 0) {
            throw new ApiError(400, "oidc_callback_failed", "Sign-in failed");
          }

          const callbackUrl = new URL(oidc.redirectUrl.href);
          for (const [key, value] of Object.entries(req.query)) {
            if (typeof value === "string") {
              callbackUrl.searchParams.set(key, value);
            }
          }

          let exchanged: Awaited<ReturnType<OidcClient["exchangeCode"]>>;
          try {
            exchanged = await client.exchangeCode({
              callbackUrl,
              codeVerifier: state.codeVerifier,
              nonce: state.nonce,
            });
          } catch (error) {
            throw toOidcApiError(error);
          }

          let identity: Awaited<ReturnType<OidcIdentityService["resolve"]>>;
          try {
            identity = await identities.resolve({
              issuer: oidc.issuer.href,
              subject: exchanged.subject,
              claims: exchanged.claims,
              userInfo: exchanged.userInfo,
              allowedDomains: oidc.allowedDomains,
            });
          } catch (error) {
            if (error instanceof OidcLinkCollisionError) {
              await req.log?.warn("oidc_link_collision", {
                issuer: oidc.issuer.href,
                subjectHash: createHash("sha256")
                  .update(exchanged.subject, "utf8")
                  .digest("hex")
                  .slice(0, 16),
              });
            }
            throw toOidcApiError(error);
          }

          const issued = await sessions.create({
            principalId: identity.principalId,
            authMethod: "oidc",
          });
          setSessionCookie(res, issued.secretId, sessions.remainingSeconds(issued.record));
          res.redirect(302, sanitizeReturnTo(state.returnTo, oidc.redirectUrl));
        }),
    ];
  }

  private async requireOidcConfig(): Promise<{
    readonly config: OpenVaultConfig;
    readonly oidc: OidcConfig;
  }> {
    const config = await this.services.get<OpenVaultConfig>("config");
    const oidc = config.oidc;
    if (oidc === undefined) {
      throw new ApiError(404, "oidc_not_configured", "OIDC is not configured");
    }
    return { config, oidc };
  }
}
