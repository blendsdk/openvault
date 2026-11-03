import {
  accessExplainQuerySchema,
  accessExplainResponseSchema,
  assignmentCreateRequestSchema,
  assignmentListQuerySchema,
  assignmentListSchema,
  assignmentSchema,
  ulidSchema,
} from "@openvault/api-contract";
import type { RouteDefinition } from "blendsdk/webafx";
import { ApiError, BaseController } from "blendsdk/webafx";
import type { Request, Response } from "express";
import { requirePrincipal } from "../auth/middleware.js";
import type { AssignmentService } from "../rbac/assignment-service.js";
import type { PolicyAuditContext } from "../rbac/audit.js";
import { PolicyUnavailableError, RbacServiceError } from "../rbac/errors.js";
import type { AssignmentRecord } from "../rbac/policy-repository.js";
import { assignmentReadLimit, assignmentWriteLimit } from "../rbac/rate-limits.js";

/** Converts a domain error into the stable WebAFX envelope. */
async function execute<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof RbacServiceError) {
      throw new ApiError(error.statusCode, error.code, error.message);
    }
    if (error instanceof PolicyUnavailableError) {
      throw new ApiError(503, "service_unavailable", "Service unavailable");
    }
    throw error;
  }
}

/** Builds request metadata for policy evidence. */
function auditContext(req: Request): PolicyAuditContext {
  return {
    ...(req.id === undefined ? {} : { requestId: req.id }),
    ...(req.ip === undefined ? {} : { sourceIp: req.ip }),
    ...(typeof req.headers["user-agent"] === "string"
      ? { userAgent: req.headers["user-agent"] }
      : {}),
  };
}

/** Serializes one assignment for the public contract. */
function toAssignment(assignment: AssignmentRecord) {
  return {
    id: assignment.id,
    principalId: assignment.principalId,
    role: assignment.role,
    scopeType: assignment.scopeType,
    scopeId: assignment.scopeId,
    grantedBy: assignment.grantedBy,
    createdAt: assignment.createdAt.toISOString(),
    expiresAt: assignment.expiresAt === null ? null : assignment.expiresAt.toISOString(),
  };
}

/** Requires a syntactically valid assignment id or returns not found. */
function assignmentId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== "string" || !ulidSchema.safeParse(id).success) {
    throw new ApiError(404, "assignment_not_found", "Assignment not found");
  }
  return id;
}

/**
 * Assignment administration routes.
 *
 * The policy service enforces every action; the controller only parses
 * requests, maps stable errors, and serializes public responses.
 */
export class AssignmentsController extends BaseController {
  /** @inheritDoc */
  public routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/")
        .middleware(assignmentReadLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = assignmentListQuerySchema.safeParse(req.query);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<AssignmentService>("assignmentService");
          const assignments = await execute(() =>
            service.list(actor.user.id, parsed.data, auditContext(req)),
          );
          this.ok(res, assignmentListSchema.parse({ assignments: assignments.map(toAssignment) }));
        }),
      this.route()
        .post("/")
        .middleware(assignmentWriteLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = assignmentCreateRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<AssignmentService>("assignmentService");
          const created = await execute(() =>
            service.create(actor.user.id, parsed.data, auditContext(req)),
          );
          this.created(res, assignmentSchema.parse(toAssignment(created)));
        }),
      this.route()
        .delete("/:id")
        .middleware(assignmentWriteLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const service = await this.services.get<AssignmentService>("assignmentService");
          await execute(() => service.delete(actor.user.id, assignmentId(req), auditContext(req)));
          this.noContent(res);
        }),
    ];
  }
}

/**
 * Access explanation route.
 *
 * The route is read-only and requires `assignment.read` on the explained
 * resource; an invisible resource returns 404.
 */
export class AccessExplainController extends BaseController {
  /** @inheritDoc */
  public routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/")
        .middleware(assignmentReadLimit())
        .handle(async (req: Request, res: Response) => {
          const actor = requirePrincipal(req);
          const parsed = accessExplainQuerySchema.safeParse(req.query);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Validation failed");
          }
          const service = await this.services.get<AssignmentService>("assignmentService");
          const explanation = await execute(() =>
            service.explain(actor.user.id, parsed.data, auditContext(req)),
          );
          this.ok(res, accessExplainResponseSchema.parse(explanation));
        }),
    ];
  }
}
