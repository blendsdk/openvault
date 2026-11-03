import {
  identityCreateRequestSchema,
  identityDetailSchema,
  identityListQuerySchema,
  identityListSchema,
  identitySummarySchema,
  joinTokenCreateRequestSchema,
  joinTokenResponseSchema,
  ulidSchema,
} from "@openvault/api-contract";
import type { RouteDefinition } from "blendsdk/webafx";
import { ApiError, BaseController } from "blendsdk/webafx";
import type { Request, Response } from "express";
import { requirePrincipal } from "../auth/middleware.js";
import { IdentityServiceError } from "../identity/errors.js";
import type { IdentityService } from "../identity/identity-service.js";

/** Converts a domain error into the stable WebAFX envelope. */
async function execute<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof IdentityServiceError) {
      throw new ApiError(error.statusCode, error.code, error.message);
    }
    throw error;
  }
}

/** Requires a syntactically valid identity id or returns the not-found code. */
function identityId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== "string" || !ulidSchema.safeParse(id).success) {
    throw new ApiError(404, "identity_not_found", "Identity not found");
  }
  return id;
}

/**
 * Administrative service-identity routes.
 *
 * The narrow identity authorizer enforces the pre-RBAC matrix; the controller
 * only parses requests, maps stable errors, and serializes public responses.
 */
export class IdentityController extends BaseController {
  /** @inheritDoc */
  public routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/")
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = identityListQuerySchema.safeParse(req.query);
          if (!parsed.success) {
            throw new ApiError(400, "validation_error", "Validation failed");
          }
          const service = await this.services.get<IdentityService>("identityService");
          const identities = await execute(() =>
            service.list(actor.user.id, parsed.data.projectId),
          );
          this.ok(res, identityListSchema.parse({ identities }));
        }),
      this.route()
        .post("/")
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = identityCreateRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(400, "validation_error", "Validation failed");
          }
          const service = await this.services.get<IdentityService>("identityService");
          const identity = await execute(() => service.create(actor.user.id, parsed.data));
          this.created(res, identitySummarySchema.parse(identity));
        }),
      this.route()
        .get("/:id")
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const service = await this.services.get<IdentityService>("identityService");
          const detail = await execute(() => service.get(actor.user.id, identityId(req)));
          this.ok(res, identityDetailSchema.parse(detail));
        }),
      this.route()
        .post("/:id/revoke")
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const service = await this.services.get<IdentityService>("identityService");
          await execute(() => service.revoke(actor.user.id, identityId(req)));
          this.noContent(res);
        }),
      this.route()
        .post("/:id/join-tokens")
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = joinTokenCreateRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(400, "validation_error", "Validation failed");
          }
          const service = await this.services.get<IdentityService>("identityService");
          const token = await execute(() =>
            service.issueJoinToken(actor.user.id, identityId(req), parsed.data.ttlSeconds),
          );
          this.created(res, joinTokenResponseSchema.parse(token));
        }),
    ];
  }
}
