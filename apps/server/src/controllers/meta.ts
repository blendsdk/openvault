import { metaAuthSchema } from "@openvault/api-contract";
import type { RouteDefinition } from "blendsdk/webafx";
import { BaseController } from "blendsdk/webafx";
import type { Request, Response } from "express";
import type { OpenVaultConfig } from "../config/index.js";

/**
 * Public capability metadata for the login page.
 *
 * The response exposes only whether local and OIDC login are available; it
 * never includes provider URLs or client credentials.
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
    ];
  }
}
