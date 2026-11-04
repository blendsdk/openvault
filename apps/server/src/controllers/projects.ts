import {
  projectCreateRequestSchema,
  projectListSchema,
  projectSchema,
  projectUpdateRequestSchema,
  ulidSchema,
} from "@openvault/api-contract";
import type { RouteDefinition } from "blendsdk/webafx";
import { ApiError, BaseController } from "blendsdk/webafx";
import type { Request, Response } from "express";
import { AuditUnavailableError } from "../audit/errors.js";
import { auditRequestContext } from "../audit/http.js";
import { requirePrincipal } from "../auth/middleware.js";
import { ProjectServiceError } from "../projects/errors.js";
import type { ProjectService } from "../projects/service.js";
import { PolicyUnavailableError } from "../rbac/errors.js";

/** Converts one project failure into the stable WebAFX envelope. */
function mapError(error: unknown): unknown {
  if (error instanceof ProjectServiceError) {
    return new ApiError(error.statusCode, error.code, error.message);
  }
  if (error instanceof PolicyUnavailableError || error instanceof AuditUnavailableError) {
    return new ApiError(503, "service_unavailable", "Service unavailable");
  }
  return error;
}

/** Runs one handler with the project error mapping. */
async function execute<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw mapError(error);
  }
}

/** Requires a syntactically valid project id or returns the stable not-found code. */
function projectId(req: Request): string {
  const id = req.params.project;
  if (typeof id !== "string" || !ulidSchema.safeParse(id).success) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }
  return id;
}

/**
 * Administrative project routes.
 *
 * The policy engine enforces the action matrix; the controller only parses,
 * maps stable errors, and serializes the public project shape.
 */
export class ProjectsController extends BaseController {
  /** @inheritDoc */
  public routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/")
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const service = await this.services.get<ProjectService>("projectService");
          const projects = await execute(() =>
            service.list(actor.user.id, auditRequestContext(req)),
          );
          this.ok(res, projectListSchema.parse({ projects }));
        }),
      this.route()
        .post("/")
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = projectCreateRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<ProjectService>("projectService");
          const project = await execute(() =>
            service.create(actor.user.id, parsed.data, auditRequestContext(req)),
          );
          this.created(res, projectSchema.parse(project));
        }),
      this.route()
        .get("/:project")
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const service = await this.services.get<ProjectService>("projectService");
          const project = await execute(() =>
            service.get(actor.user.id, projectId(req), auditRequestContext(req)),
          );
          this.ok(res, projectSchema.parse(project));
        }),
      this.route()
        .patch("/:project")
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = projectUpdateRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<ProjectService>("projectService");
          const project = await execute(() =>
            service.update(actor.user.id, projectId(req), parsed.data, auditRequestContext(req)),
          );
          this.ok(res, projectSchema.parse(project));
        }),
      this.route()
        .delete("/:project")
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const service = await this.services.get<ProjectService>("projectService");
          await execute(() =>
            service.delete(actor.user.id, projectId(req), auditRequestContext(req)),
          );
          this.noContent(res);
        }),
    ];
  }
}
