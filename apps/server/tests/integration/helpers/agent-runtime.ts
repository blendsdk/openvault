import { setTimeout as delay } from "node:timers/promises";
import { ApiError, BaseController, type RouteDefinition } from "blendsdk/webafx";
import type { Request, Response } from "express";
import type { AgentAuthenticator } from "../../../src/agent/agent-authenticator.js";
import { requireAgent } from "../../../src/agent/agent-middleware.js";
import type { SecureWebApplication } from "../../../src/transport/secure-application.js";

/** Fixed secret returned by the test-only data route. */
export const DATA_PROBE_SECRET = "agent-data-probe-secret";

let probeDelayMs = 0;
let probeOnEnter: (() => void) | undefined;

/**
 * Test-only data route that exercises the agent middleware and the pre-send
 * revalidation obligation without adding a production secret handler.
 */
class AgentDataProbeController extends BaseController {
  public routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/:project/secrets/:name")
        .handle(async (req: Request, res: Response) => {
          const context = requireAgent(req);
          probeOnEnter?.();
          if (probeDelayMs > 0) {
            await delay(probeDelayMs);
          }
          const authenticator = await req.services.get<AgentAuthenticator>("agentAuthenticator");
          const revalidated = await authenticator.revalidate(req);
          if (revalidated === undefined) {
            throw new ApiError(401, "authentication_required", "Authentication required");
          }
          this.ok(res, {
            secret: DATA_PROBE_SECRET,
            projectId: context.projectId,
            hasAuth: req.auth !== undefined,
            agentKind: context.kind,
          });
        }),
    ];
  }
}

/**
 * Registers the test-only data probe before the application is prepared.
 *
 * @param app - Application being assembled.
 * @param options - Optional delay before the pre-send revalidation.
 */
export function registerAgentDataProbe(
  app: SecureWebApplication,
  options: { readonly delayMs?: number; readonly onEnter?: () => void } = {},
): void {
  probeDelayMs = options.delayMs ?? 0;
  probeOnEnter = options.onEnter;
  app.registerController("/v1/data", AgentDataProbeController);
}
