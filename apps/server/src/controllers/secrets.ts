import {
  projectNameSchema,
  secretConsumerListSchema,
  secretCreateRequestSchema,
  secretListQuerySchema,
  secretListSchema,
  secretNameSchema,
  secretReadQuerySchema,
  secretValueResponseSchema,
  secretValueWriteRequestSchema,
  secretVersionListSchema,
  secretWriteResponseSchema,
} from "@openvault/api-contract";
import { KeyringError } from "@openvault/core";
import type { RouteDefinition } from "blendsdk/webafx";
import { ApiError, BaseController } from "blendsdk/webafx";
import type { Request, Response } from "express";
import { requireAgent } from "../agent/agent-middleware.js";
import { AuditUnavailableError } from "../audit/errors.js";
import { auditRequestContext } from "../audit/http.js";
import { requirePrincipal } from "../auth/middleware.js";
import { PolicyUnavailableError } from "../rbac/errors.js";
import { SecretServiceError } from "../secrets/errors.js";
import { secretRateLimit } from "../secrets/rate-limits.js";
import type { SecretService } from "../secrets/service.js";
import { listenerOf } from "../transport/scope.js";

/** Converts one secret failure into the stable WebAFX envelope. */
function mapError(error: unknown): unknown {
  if (error instanceof SecretServiceError) {
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

/** Runs one handler with the secret error mapping. */
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

/** Returns the secret name or the stable not-found error. */
function secretName(req: Request): string {
  const value = req.params.name;
  if (typeof value !== "string" || !secretNameSchema.safeParse(value).success) {
    throw new ApiError(404, "secret_not_found", "Secret not found");
  }
  return value;
}

/** Returns the optional Idempotency-Key header. */
function idempotencyKey(req: Request): string | undefined {
  const header = req.headers["idempotency-key"];
  if (header === undefined) {
    return undefined;
  }
  if (typeof header !== "string") {
    throw new ApiError(422, "validation_error", "Validation failed");
  }
  return header;
}

/** Resolves the actor for a data route. */
function principal(req: Request): { readonly id: string; readonly agentId?: string } {
  if (listenerOf(req) === "agent") {
    const agent = requireAgent(req);
    return { id: agent.principalId, agentId: agent.principalId };
  }
  return { id: requirePrincipal(req).user.id };
}

/**
 * Data-plane project and secret routes.
 *
 * The agent listener serves only the value read; every other route requires a
 * browser or CLI principal.
 */
export class SecretsController extends BaseController {
  /** @inheritDoc */
  public routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/:project/secrets")
        .middleware(secretRateLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = principal(req);
          const parsed = secretListQuerySchema.safeParse(req.query);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<SecretService>("secretService");
          const result = await execute(() =>
            service.list(actor.id, projectName(req), parsed.data, auditRequestContext(req)),
          );
          this.ok(res, secretListSchema.parse(result));
        }),
      this.route()
        .post("/:project/secrets")
        .middleware(secretRateLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = principal(req);
          const parsed = secretCreateRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<SecretService>("secretService");
          const result = await execute(() =>
            service.create(
              actor.id,
              projectName(req),
              parsed.data,
              auditRequestContext(req),
              idempotencyKey(req),
            ),
          );
          this.created(res, secretWriteResponseSchema.parse(result));
        }),
      this.route()
        .get("/:project/secrets/:name")
        .middleware(secretRateLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = principal(req);
          const parsed = secretReadQuerySchema.safeParse(req.query);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<SecretService>("secretService");
          const result = await execute(() =>
            service.read(
              actor.id,
              projectName(req),
              secretName(req),
              parsed.data,
              auditRequestContext(req),
              actor.agentId === undefined ? {} : { agentPrincipalId: actor.agentId },
            ),
          );
          this.ok(res, secretValueResponseSchema.parse(result));
        }),
      this.route()
        .get("/:project/secrets/:name/versions")
        .middleware(secretRateLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = principal(req);
          const service = await this.services.get<SecretService>("secretService");
          const versions = await execute(() =>
            service.versions(actor.id, projectName(req), secretName(req), auditRequestContext(req)),
          );
          this.ok(res, secretVersionListSchema.parse({ versions }));
        }),
      this.route()
        .get("/:project/secrets/:name/consumers")
        .middleware(secretRateLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = principal(req);
          const service = await this.services.get<SecretService>("secretService");
          const consumers = await execute(() =>
            service.consumers(
              actor.id,
              projectName(req),
              secretName(req),
              auditRequestContext(req),
            ),
          );
          this.ok(res, secretConsumerListSchema.parse({ consumers }));
        }),
      this.route()
        .put("/:project/secrets/:name")
        .middleware(secretRateLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = principal(req);
          const parsed = secretValueWriteRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<SecretService>("secretService");
          const result = await execute(() =>
            service.write(
              actor.id,
              projectName(req),
              secretName(req),
              parsed.data,
              auditRequestContext(req),
              idempotencyKey(req),
            ),
          );
          this.ok(res, secretWriteResponseSchema.parse(result));
        }),
    ];
  }
}
