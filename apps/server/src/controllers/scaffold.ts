import { scaffoldRequestSchema, scaffoldResponseSchema } from "@openvault/api-contract";
import type { RouteDefinition } from "blendsdk/webafx";
import { ApiError, BaseController } from "blendsdk/webafx";
import type { Request, Response } from "express";
import { AuditUnavailableError } from "../audit/errors.js";
import { auditRequestContext } from "../audit/http.js";
import { requirePrincipal } from "../auth/middleware.js";
import { IdentityServiceError } from "../identity/errors.js";
import { ProjectServiceError } from "../projects/errors.js";
import { PolicyUnavailableError, RbacServiceError } from "../rbac/errors.js";
import { scaffoldWriteLimit } from "../rbac/rate-limits.js";
import { ScaffoldServiceError } from "../scaffold/errors.js";
import type { ScaffoldService } from "../scaffold/service.js";

/** Converts one scaffold failure into the stable WebAFX envelope. */
function mapError(error: unknown): unknown {
  if (error instanceof ScaffoldServiceError) {
    return new ApiError(error.statusCode, error.code, error.message);
  }
  if (error instanceof ProjectServiceError || error instanceof IdentityServiceError) {
    return new ApiError(error.statusCode, error.code, error.message);
  }
  if (error instanceof RbacServiceError) {
    return new ApiError(error.statusCode, error.code, error.message);
  }
  if (error instanceof PolicyUnavailableError || error instanceof AuditUnavailableError) {
    return new ApiError(503, "service_unavailable", "Service unavailable");
  }
  return error;
}

/** Runs one handler with the scaffold error mapping. */
async function execute<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Administrative Compose scaffold route.
 *
 * The service owns idempotence, authorization, object-scope grants, and token
 * rotation. The controller parses the strict body and maps stable errors.
 */
export class ScaffoldController extends BaseController {
  /** @inheritDoc */
  public routes(): RouteDefinition[] {
    return [
      this.route()
        .post("/")
        .middleware(scaffoldWriteLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = scaffoldRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<ScaffoldService>("scaffoldService");
          const result = await execute(() =>
            service.scaffold(actor.user.id, parsed.data, auditRequestContext(req)),
          );
          this.ok(res, scaffoldResponseSchema.parse(result));
        }),
    ];
  }
}
