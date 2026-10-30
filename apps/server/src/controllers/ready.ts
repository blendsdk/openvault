import type { RouteDefinition } from "blendsdk/webafx";
import { BaseController } from "blendsdk/webafx";
import type { Request, Response } from "express";

/**
 * Exposes the root readiness contract.
 *
 * The dependency probes are added by the readiness service once their
 * PostgreSQL, keyring, TLS, and audit checks are available. The route stays at
 * `/ready`; `/v1/ready` is not part of the contract.
 */
export class ReadyController extends BaseController {
  public routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/ready")
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { status: "ready" });
        }),
    ];
  }
}
