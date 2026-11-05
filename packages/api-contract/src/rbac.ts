import { z } from "zod";
import { RBAC_ACTIONS } from "./actions.js";
import { ulidSchema } from "./ids.js";

export { RBAC_ACTIONS, type RbacAction } from "./actions.js";

/**
 * The nine fixed roles.
 *
 * Custom roles are not supported in v0.1. The order is the public catalog
 * order used by the role reference and the catalog response.
 */
export const RBAC_ROLES = [
  "org.admin",
  "project.admin",
  "secrets.manager",
  "secrets.officer",
  "secrets.reader",
  "certificates.officer",
  "certificates.reader",
  "auditor",
  "reader",
] as const;

/** One fixed authorization role. */
export type RbacRole = (typeof RBAC_ROLES)[number];

/** The three assignment scopes. */
export const rbacScopeTypeSchema = z.enum(["org", "project", "object"]);

/** One assignment scope. */
export type RbacScopeType = z.infer<typeof rbacScopeTypeSchema>;

/** One action in the public catalog. */
export const rbacActionDefinitionSchema = z.strictObject({
  name: z.enum(RBAC_ACTIONS),
  plane: z.enum(["control", "data"]),
  description: z.string().min(1).max(160),
});

/** One role in the public catalog. */
export const rbacRoleDefinitionSchema = z.strictObject({
  name: z.enum(RBAC_ROLES),
  actions: z.array(z.enum(RBAC_ACTIONS)),
  scopes: z.array(rbacScopeTypeSchema),
});

/**
 * The public role and action catalog.
 *
 * `policyVersion` changes in the same transaction as every assignment
 * mutation, so clients can detect policy changes without reading assignments.
 */
export const roleCatalogSchema = z.strictObject({
  actions: z.array(rbacActionDefinitionSchema),
  roles: z.array(rbacRoleDefinitionSchema),
  policyVersion: z.number().int().nonnegative(),
});

/** One persisted role assignment. */
export const assignmentSchema = z.strictObject({
  id: ulidSchema,
  principalId: ulidSchema,
  role: z.enum(RBAC_ROLES),
  scopeType: rbacScopeTypeSchema,
  scopeId: z.string().min(1).max(26),
  grantedBy: ulidSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
});

/** A list of assignments. */
export const assignmentListSchema = z.strictObject({
  assignments: z.array(assignmentSchema),
});

/** Request body for granting an assignment. */
export const assignmentCreateRequestSchema = z
  .strictObject({
    principalId: ulidSchema,
    role: z.enum(RBAC_ROLES),
    scopeType: rbacScopeTypeSchema,
    scopeId: z.string().min(1).max(26),
    expiresAt: z.iso.datetime().optional(),
  })
  .superRefine((value, context) => {
    if (value.expiresAt !== undefined && Date.parse(value.expiresAt) <= Date.now()) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiry must be in the future",
      });
    }
    if (value.scopeType === "org") {
      if (value.scopeId !== "org") {
        context.addIssue({
          code: "custom",
          path: ["scopeId"],
          message: "organization scope requires the org id",
        });
      }
      return;
    }
    if (!ulidSchema.safeParse(value.scopeId).success) {
      context.addIssue({
        code: "custom",
        path: ["scopeId"],
        message: "project and object scopes require an object identifier",
      });
    }
  });

/** Query filters for the assignment list. */
export const assignmentListQuerySchema = z
  .strictObject({
    principalId: ulidSchema.optional(),
    role: z.enum(RBAC_ROLES).optional(),
    scopeType: rbacScopeTypeSchema.optional(),
    scopeId: z.string().min(1).max(26).optional(),
  })
  .superRefine((value, context) => {
    if (value.scopeType === "org" && value.scopeId !== undefined && value.scopeId !== "org") {
      context.addIssue({
        code: "custom",
        path: ["scopeId"],
        message: "organization scope requires the org id",
      });
    }
    if (
      value.scopeType !== "org" &&
      value.scopeId !== undefined &&
      !ulidSchema.safeParse(value.scopeId).success
    ) {
      context.addIssue({
        code: "custom",
        path: ["scopeId"],
        message: "scope id must be a ULID",
      });
    }
  });

/** Query for one access explanation. */
export const accessExplainQuerySchema = z
  .strictObject({
    action: z.enum(RBAC_ACTIONS),
    scopeType: rbacScopeTypeSchema.optional(),
    scopeId: z.string().min(1).max(26).optional(),
    objectType: z.enum(["secret", "certificate", "identity"]).optional(),
  })
  .superRefine((value, context) => {
    if (value.scopeType === "org") {
      if (value.scopeId !== undefined && value.scopeId !== "org") {
        context.addIssue({
          code: "custom",
          path: ["scopeId"],
          message: "organization scope requires the org id",
        });
      }
    } else if (value.scopeType === "project" || value.scopeType === "object") {
      if (value.scopeId === undefined || !ulidSchema.safeParse(value.scopeId).success) {
        context.addIssue({
          code: "custom",
          path: ["scopeId"],
          message: "project and object scopes require an object identifier",
        });
      }
    } else if (value.scopeId !== undefined && value.scopeId !== "org") {
      context.addIssue({
        code: "custom",
        path: ["scopeId"],
        message: "a scope type is required for a project or object scope id",
      });
    }

    if (value.objectType !== undefined && value.scopeType !== "object") {
      context.addIssue({
        code: "custom",
        path: ["objectType"],
        message: "object type is only valid for object scope",
      });
    }

    const dataPlane = value.action.startsWith("secret.") || value.action.startsWith("certificate.");
    if (dataPlane && (value.scopeType === undefined || value.scopeType === "org")) {
      context.addIssue({
        code: "custom",
        path: ["scopeType"],
        message: "data-plane explanations require project or object scope",
      });
    }
  });

/** Consumer metadata attached to a service-principal explanation. */
export const accessExplainConsumerSchema = z.strictObject({
  composeProject: z.string().min(1).max(100),
  composeService: z.string().min(1).max(100),
  hostname: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/),
  state: z.enum(["ok", "degraded", "failed"]),
  lastSeen: z.iso.datetime(),
});

/** One principal with an effective permission on the explained resource. */
export const accessExplainEntrySchema = z.strictObject({
  principalId: ulidSchema,
  name: z.string().min(1).max(100),
  kind: z.enum(["user", "service"]),
  role: z.enum(RBAC_ROLES),
  assignmentId: ulidSchema,
  scopeType: rbacScopeTypeSchema,
  scopeId: z.string().min(1).max(26),
  consumer: accessExplainConsumerSchema.nullable(),
});

/** The access explanation for one action and resource. */
export const accessExplainResponseSchema = z.strictObject({
  policyVersion: z.number().int().nonnegative(),
  action: z.enum(RBAC_ACTIONS),
  scope: z.strictObject({
    type: rbacScopeTypeSchema,
    id: z.string().min(1).max(26),
  }),
  principals: z.array(accessExplainEntrySchema),
});

/** Per-object capability flags for the current principal. */
export const capabilityFlagsSchema = z.strictObject({
  canRead: z.boolean(),
  canWrite: z.boolean(),
  canDelete: z.boolean(),
  canPurge: z.boolean(),
  canManage: z.boolean(),
});

/** One persisted assignment. */
export type Assignment = z.infer<typeof assignmentSchema>;
/** Request body for granting an assignment. */
export type AssignmentCreateRequest = z.infer<typeof assignmentCreateRequestSchema>;
/** Query filters for the assignment list. */
export type AssignmentListQuery = z.infer<typeof assignmentListQuerySchema>;
/** Query for one access explanation. */
export type AccessExplainQuery = z.infer<typeof accessExplainQuerySchema>;
/** The access explanation response. */
export type AccessExplainResponse = z.infer<typeof accessExplainResponseSchema>;
/** Consumer metadata in an access explanation. */
export type AccessExplainConsumer = z.infer<typeof accessExplainConsumerSchema>;
/** One principal entry in an access explanation. */
export type AccessExplainEntry = z.infer<typeof accessExplainEntrySchema>;
/** Per-object capability flags. */
export type CapabilityFlags = z.infer<typeof capabilityFlagsSchema>;
/** The public role and action catalog. */
export type RoleCatalog = z.infer<typeof roleCatalogSchema>;
