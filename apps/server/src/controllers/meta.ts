import { metaAuthSchema, roleCatalogSchema } from "@openvault/api-contract";
import type { RouteDefinition } from "blendsdk/webafx";
import { ApiError, BaseController } from "blendsdk/webafx";
import type { Request, Response } from "express";
import type { OpenVaultConfig } from "../config/index.js";
import { PolicyUnavailableError } from "../rbac/errors.js";
import type { PolicyService } from "../rbac/policy-service.js";

/**
 * Public capability metadata for clients.
 *
 * The auth route exposes only whether local and OIDC login are available. The
 * roles route publishes the static policy catalog and its current version; it
 * never includes principals, assignments, or project data.
 */
export class MetaController extends BaseController {
  /** @inheritDoc */
  public routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/auth")
        .handle(async (_req: Request, res: Response) => {
          const config = await this.services.get<OpenVaultConfig>("config");
          this.ok(res, metaAuthSchema.parse({ local: true, oidc: config.oidc !== undefined }));
        }),
      this.route()
        .get("/roles")
        .handle(async (_req: Request, res: Response) => {
          const policy = await this.services.get<PolicyService>("policyService");
          try {
            this.ok(res, roleCatalogSchema.parse(await policy.catalog()));
          } catch (error) {
            if (error instanceof PolicyUnavailableError) {
              throw new ApiError(503, "service_unavailable", "Service unavailable");
            }
            throw error;
          }
        }),
    ];
  }
}
