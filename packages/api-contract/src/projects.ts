import { z } from "zod";
import { projectNameSchema, ulidSchema } from "./ids.js";

/** Request body for creating a project. */
export const projectCreateRequestSchema = z.strictObject({
  name: projectNameSchema,
});

/** Request body for renaming a project. */
export const projectUpdateRequestSchema = z.strictObject({
  name: projectNameSchema,
});

/** Public project summary. */
export const projectSchema = z.strictObject({
  id: ulidSchema,
  name: projectNameSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** Project list item with the active certificate count needed by the UI. */
export const projectListItemSchema = projectSchema.extend({
  certificateCount: z.number().int().min(0),
});

/** Project list response. */
export const projectListSchema = z.strictObject({
  projects: z.array(projectListItemSchema),
});

/** Inferred project create request. */
export type ProjectCreateRequest = z.infer<typeof projectCreateRequestSchema>;
/** Inferred project update request. */
export type ProjectUpdateRequest = z.infer<typeof projectUpdateRequestSchema>;
/** Inferred project summary. */
export type Project = z.infer<typeof projectSchema>;
/** Inferred project list item. */
export type ProjectListItem = z.infer<typeof projectListItemSchema>;
/** Inferred project list. */
export type ProjectList = z.infer<typeof projectListSchema>;
