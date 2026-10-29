import type { RouteDefinition } from "blendsdk/webafx";
import { BaseController } from "blendsdk/webafx";
import type { Request, Response } from "express";

/** Exposes a cheap readiness signal for container orchestration. */
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
