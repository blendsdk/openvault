import type { RouteDefinition } from "blendsdk/webafx";
import { ApiError, BaseController } from "blendsdk/webafx";
import type { Request, Response } from "express";
import { ReadinessError, type ReadinessService } from "../readiness/service.js";

/**
 * Reports dependency readiness at the root `/ready` path.
 *
 * Liveness stays at WebAFX's `/health`; this controller checks PostgreSQL,
 * the keyring, TLS material, and the audit table. A failed probe is logged with
 * its fixed name and reported as a generic 503 so no dependency detail leaks.
 */
export class ReadyController extends BaseController {
  public routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/ready")
        .handle(async (req: Request, res: Response) => {
          const readiness = await this.services.get<ReadinessService>("readiness");
          try {
            await readiness.check();
          } catch (error) {
            if (error instanceof ReadinessError) {
              await req.log?.warn("readiness probe failed", { probe: error.probe });
              throw new ApiError(503, "not_ready", "Not ready");
            }
            throw error;
          }
          this.ok(res, { status: "ready" });
        }),
    ];
  }
}
