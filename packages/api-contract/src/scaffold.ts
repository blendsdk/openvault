import { z } from "zod";
import { identityNameSchema, joinTokenResponseSchema } from "./identities.js";
import { projectNameSchema, secretNameSchema, ulidSchema } from "./ids.js";
import { assignmentSchema, type RbacRole, rbacScopeTypeSchema } from "./rbac.js";

/**
 * A Compose-safe service name used in generated paths and YAML keys.
 *
 * The general identity-name contract allows Unicode and punctuation, which is
 * useful for admin-created identities but unsafe in a host path or a Compose
 * key. The scaffold accepts only this narrower slug.
 *
 * @example
 * ```ts
 * composeServiceNameSchema.parse("api");
 * ```
 */
export const composeServiceNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "invalid compose service name");

/**
 * Request body for the Compose scaffold endpoint.
 *
 * Entries are the secret names that become object-scope reader grants. A
 * project with entries must already exist because it must already contain
 * those secrets; an empty entry list may create a new project and identity.
 */
export const scaffoldRequestSchema = z
  .strictObject({
    project: projectNameSchema,
    service: composeServiceNameSchema,
    entries: z.array(secretNameSchema).max(100).default([]),
  })
  .superRefine((value, context) => {
    if (new Set(value.entries).size !== value.entries.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "entries must be unique",
      });
    }
  });

/** One object-scope grant created or reused by the scaffold. */
export const scaffoldAssignmentSchema = z.strictObject({
  name: secretNameSchema,
  assignment: assignmentSchema,
});

/** The public project shape returned by the scaffold. */
export const scaffoldProjectSchema = z.strictObject({
  id: ulidSchema,
  name: projectNameSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** The public identity summary returned by the scaffold. */
export const scaffoldIdentitySchema = z.strictObject({
  id: ulidSchema,
  name: identityNameSchema,
  projectId: ulidSchema,
  status: z.enum(["active", "disabled"]),
  createdAt: z.iso.datetime(),
});

/**
 * Response from the Compose scaffold endpoint.
 *
 * The join token is a one-time credential and is returned exactly once. It is
 * never embedded in `compose` or `manifest`.
 */
export const scaffoldResponseSchema = z.strictObject({
  project: scaffoldProjectSchema,
  identity: scaffoldIdentitySchema,
  assignments: z.array(scaffoldAssignmentSchema),
  joinToken: joinTokenResponseSchema,
  compose: z.string().min(1),
  manifest: z.string().min(1),
  manifestFile: z.string().min(1),
});

/** Inferred scaffold request. */
export type ScaffoldRequest = z.infer<typeof scaffoldRequestSchema>;

/** Inferred scaffold response. */
export type ScaffoldResponse = z.infer<typeof scaffoldResponseSchema>;

/** One scaffold assignment entry. */
export type ScaffoldAssignment = z.infer<typeof scaffoldAssignmentSchema>;

/** Re-exported role type for scaffold consumers. */
export type ScaffoldRole = RbacRole;

/** Re-exported assignment scope type. */
export const scaffoldScopeTypeSchema = rbacScopeTypeSchema;
