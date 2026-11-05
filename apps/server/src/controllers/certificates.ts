import {
  certificateGenerateRequestSchema,
  certificateImportRequestSchema,
  certificateListQuerySchema,
  certificateListSchema,
  certificateMetadataSchema,
  certificateMetadataUpdateRequestSchema,
  certificateNameSchema,
  certificatePrivateKeyResponseSchema,
  certificatePublicResponseSchema,
  certificateReadQuerySchema,
  certificateWriteResponseSchema,
  projectNameSchema,
} from "@openvault/api-contract";
import { KeyringError } from "@openvault/core";
import type { RouteDefinition } from "blendsdk/webafx";
import { ApiError, BaseController } from "blendsdk/webafx";
import type { Request, Response } from "express";
import { AuditUnavailableError } from "../audit/errors.js";
import { auditRequestContext } from "../audit/http.js";
import { requirePrincipal } from "../auth/middleware.js";
import { CertificateServiceError } from "../certificates/errors.js";
import type { CertificateLifecycle } from "../certificates/lifecycle.js";
import {
  certificatePrivateKeyRateLimit,
  certificateWriteRateLimit,
} from "../certificates/rate-limits.js";
import type { CertificateService } from "../certificates/service.js";
import { PolicyUnavailableError } from "../rbac/errors.js";
import { secretRateLimit } from "../secrets/rate-limits.js";

/** Converts one certificate failure into the stable WebAFX envelope. */
function mapError(error: unknown): unknown {
  if (error instanceof CertificateServiceError) {
    return new ApiError(error.statusCode, error.code, error.message);
  }
  if (
    error instanceof PolicyUnavailableError ||
    error instanceof AuditUnavailableError ||
    error instanceof KeyringError
  ) {
    return new ApiError(503, "service_unavailable", "Service unavailable");
  }
  return error;
}

/** Runs one handler with the certificate error mapping. */
async function execute<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw mapError(error);
  }
}

/** Returns the active project name or the stable not-found error. */
function projectName(req: Request): string {
  const value = req.params.project;
  if (typeof value !== "string" || !projectNameSchema.safeParse(value).success) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }
  return value;
}

/** Returns the certificate name or the stable not-found error. */
function certificateName(req: Request): string {
  const value = req.params.name;
  if (typeof value !== "string" || !certificateNameSchema.safeParse(value).success) {
    throw new ApiError(404, "certificate_not_found", "Certificate not found");
  }
  return value;
}

/**
 * Data-plane certificate routes.
 *
 * Every route requires a browser or CLI principal. Certificate requests on the agent listener
 * are denied; v0.1 agent delivery is secrets only.
 */
export class CertificatesController extends BaseController {
  /** @inheritDoc */
  public routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/:project/certificates")
        .middleware(secretRateLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = certificateListQuerySchema.safeParse(req.query);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<CertificateService>("certificateService");
          const result = await execute(() =>
            service.list(actor.user.id, projectName(req), parsed.data, auditRequestContext(req)),
          );
          const parsedResult = certificateListSchema.safeParse(result);
          if (!parsedResult.success) {
            throw new ApiError(500, "internal_error", "Internal Server Error");
          }
          this.ok(res, parsedResult.data);
        }),
      this.route()
        .post("/:project/certificates/import")
        .middleware(secretRateLimit())
        .middleware(certificateWriteRateLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = certificateImportRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<CertificateService>("certificateService");
          const result = await execute(() =>
            service.import(actor.user.id, projectName(req), parsed.data, auditRequestContext(req)),
          );
          const body = certificateWriteResponseSchema.parse(result.response);
          if (result.created) {
            this.created(res, body);
          } else {
            this.ok(res, body);
          }
        }),
      this.route()
        .post("/:project/certificates/generate")
        .middleware(secretRateLimit())
        .middleware(certificateWriteRateLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = certificateGenerateRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<CertificateService>("certificateService");
          const result = await execute(() =>
            service.generate(
              actor.user.id,
              projectName(req),
              parsed.data,
              auditRequestContext(req),
            ),
          );
          const body = certificateWriteResponseSchema.parse(result.response);
          if (result.created) {
            this.created(res, body);
          } else {
            this.ok(res, body);
          }
        }),
      this.route()
        .get("/:project/certificates/:name")
        .middleware(secretRateLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = certificateReadQuerySchema.safeParse(req.query);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<CertificateService>("certificateService");
          const result = await execute(() =>
            service.read(
              actor.user.id,
              projectName(req),
              certificateName(req),
              parsed.data,
              auditRequestContext(req),
            ),
          );
          this.ok(res, certificatePublicResponseSchema.parse(result));
        }),
      this.route()
        .get("/:project/certificates/:name/private-key")
        .middleware(secretRateLimit())
        .middleware(certificatePrivateKeyRateLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = certificateReadQuerySchema.safeParse(req.query);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<CertificateService>("certificateService");
          const result = await execute(() =>
            service.readPrivate(
              actor.user.id,
              projectName(req),
              certificateName(req),
              parsed.data,
              auditRequestContext(req),
            ),
          );
          this.ok(res, certificatePrivateKeyResponseSchema.parse(result));
        }),
      this.route()
        .patch("/:project/certificates/:name")
        .middleware(secretRateLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = certificateMetadataUpdateRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const lifecycle = await this.services.get<CertificateLifecycle>("certificateLifecycle");
          const result = await execute(() =>
            lifecycle.updateMetadata(
              actor.user.id,
              projectName(req),
              certificateName(req),
              parsed.data,
              auditRequestContext(req),
            ),
          );
          this.ok(res, certificateMetadataSchema.parse(result));
        }),
      this.route()
        .delete("/:project/certificates/:name")
        .middleware(secretRateLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const lifecycle = await this.services.get<CertificateLifecycle>("certificateLifecycle");
          await execute(() =>
            lifecycle.delete(
              actor.user.id,
              projectName(req),
              certificateName(req),
              auditRequestContext(req),
            ),
          );
          this.noContent(res);
        }),
      this.route()
        .post("/:project/certificates/:name/recover")
        .middleware(secretRateLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const lifecycle = await this.services.get<CertificateLifecycle>("certificateLifecycle");
          const result = await execute(() =>
            lifecycle.recover(
              actor.user.id,
              projectName(req),
              certificateName(req),
              auditRequestContext(req),
            ),
          );
          this.ok(res, certificateMetadataSchema.parse(result));
        }),
      this.route()
        .post("/:project/certificates/:name/purge")
        .middleware(secretRateLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const lifecycle = await this.services.get<CertificateLifecycle>("certificateLifecycle");
          await execute(() =>
            lifecycle.purge(
              actor.user.id,
              projectName(req),
              certificateName(req),
              auditRequestContext(req),
            ),
          );
          this.noContent(res);
        }),
    ];
  }
}
