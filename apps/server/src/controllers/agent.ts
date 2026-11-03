import {
  agentCertificateResponseSchema,
  agentJoinRequestSchema,
  agentRenewRequestSchema,
} from "@openvault/api-contract";
import type { RouteDefinition } from "blendsdk/webafx";
import { ApiError, BaseController } from "blendsdk/webafx";
import type { Request, Response } from "express";
import type { AgentJoinService } from "../agent/agent-join-service.js";
import { requireAgent } from "../agent/agent-middleware.js";
import { joinIpLimit, renewIpLimit, renewPrincipalLimit } from "../agent/agent-rate-limits.js";
import type { AgentRenewService } from "../agent/agent-renew-service.js";
import { AgentServiceError } from "../agent/errors.js";

/** Converts a domain error into the stable WebAFX envelope. */
async function execute<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AgentServiceError) {
      throw new ApiError(error.statusCode, error.code, error.message);
    }
    throw error;
  }
}

/** Returns true when a join schema failure is a token-envelope bound failure. */
function isTokenEnvelopeFailure(error: {
  readonly issues: readonly { readonly path: readonly PropertyKey[] }[];
}): boolean {
  return error.issues.some((issue) => issue.path[0] === "token");
}

/**
 * Agent join and renewal routes.
 *
 * Join is the only unauthenticated agent route and is rate limited by source
 * address. Renewal requires the mTLS context attached by the agent middleware
 * and is limited both by principal and by source address.
 */
export class AgentController extends BaseController {
  /** @inheritDoc */
  public routes(): RouteDefinition[] {
    return [
      this.route()
        .post("/join")
        .middleware(joinIpLimit())
        .handle(async (req: Request, res: Response) => {
          const parsed = agentJoinRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            const statusCode = isTokenEnvelopeFailure(parsed.error) ? 400 : 422;
            throw new ApiError(statusCode, "validation_error", "Validation failed");
          }
          const service = await this.services.get<AgentJoinService>("agentJoinService");
          const response = await execute(() => service.join(parsed.data));
          this.ok(res, agentCertificateResponseSchema.parse(response));
        }),
      this.route()
        .post("/renew")
        .middleware(renewPrincipalLimit())
        .middleware(renewIpLimit())
        .handle(async (req: Request, res: Response) => {
          const context = requireAgent(req);
          const parsed = agentRenewRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<AgentRenewService>("agentRenewService");
          const response = await execute(() => service.renew(context, parsed.data));
          this.ok(res, agentCertificateResponseSchema.parse(response));
        }),
    ];
  }
}
