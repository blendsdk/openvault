import {
  auditEventListSchema,
  auditExportQuerySchema,
  auditQuerySchema,
  auditVerifyResponseSchema,
} from "@openvault/api-contract";
import type { RouteDefinition } from "blendsdk/webafx";
import { ApiError, BaseController } from "blendsdk/webafx";
import type { Request, Response } from "express";
import { auditEventLimit, auditExportLimit, auditVerifyLimit } from "../audit/audit-rate-limits.js";
import type { AuditService } from "../audit/audit-service.js";
import { AuditAccessDeniedError, AuditQueryError, AuditUnavailableError } from "../audit/errors.js";
import { auditRequestContext } from "../audit/http.js";
import { requirePrincipal } from "../auth/middleware.js";
import { PolicyUnavailableError } from "../rbac/errors.js";

/** Maps one audit failure to the stable WebAFX envelope. */
function mapError(error: unknown): unknown {
  if (error instanceof AuditQueryError) {
    return new ApiError(422, "validation_error", "Validation failed");
  }
  if (error instanceof AuditAccessDeniedError) {
    return new ApiError(403, "access_denied", "Access denied");
  }
  if (error instanceof AuditUnavailableError || error instanceof PolicyUnavailableError) {
    return new ApiError(503, "service_unavailable", "Service unavailable");
  }
  return error;
}

/** Runs one handler with the audit error mapping. */
async function execute<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Audit query, verification, and export routes.
 *
 * Authorization is evaluated by the audit service so each route produces one
 * policy decision and, for verify/export, one business result event.
 */
export class AuditController extends BaseController {
  /** @inheritDoc */
  public routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/events")
        .middleware(auditEventLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = auditQuerySchema.safeParse(req.query);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<AuditService>("auditService");
          const result = await execute(() =>
            service.query(actor.user.id, parsed.data, auditRequestContext(req)),
          );
          this.ok(res, auditEventListSchema.parse(result));
        }),
      this.route()
        .get("/verify")
        .middleware(auditVerifyLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const service = await this.services.get<AuditService>("auditService");
          const result = await execute(() =>
            service.verify(actor.user.id, auditRequestContext(req)),
          );
          this.ok(res, auditVerifyResponseSchema.parse(result));
        }),
      this.route()
        .get("/export")
        .middleware(auditExportLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = auditExportQuerySchema.safeParse(req.query);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<AuditService>("auditService");
          let started = false;
          const start = (): void => {
            started = true;
            res.status(200);
            res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
            res.setHeader(
              "Content-Disposition",
              `attachment; filename="audit-${new Date().toISOString().replaceAll(":", "-")}.ndjson"`,
            );
            res.setHeader("Cache-Control", "no-store");
          };
          const write = (line: string): Promise<void> =>
            new Promise((resolve, reject) => {
              let settled = false;
              const finish = (error?: Error): void => {
                if (settled) {
                  return;
                }
                settled = true;
                res.off("drain", onDrain);
                res.off("error", onError);
                res.off("close", onClose);
                if (error === undefined) {
                  resolve();
                } else {
                  reject(error);
                }
              };
              const onDrain = (): void => finish();
              const onError = (error: Error): void => finish(error);
              const onClose = (): void => {
                if (!res.writableEnded) {
                  finish(new Error("Client disconnected"));
                }
              };
              res.once("drain", onDrain);
              res.once("error", onError);
              res.once("close", onClose);
              try {
                if (res.write(line)) {
                  finish();
                }
              } catch (error) {
                finish(error instanceof Error ? error : new Error("Write failed"));
              }
            });

          try {
            await service.export(
              actor.user.id,
              parsed.data,
              auditRequestContext(req),
              start,
              write,
            );
            res.end();
          } catch (error) {
            if (started) {
              res.destroy(error instanceof Error ? error : undefined);
              return;
            }
            throw mapError(error);
          }
        }),
    ];
  }
}
