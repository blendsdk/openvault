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

/** Project list response. */
export const projectListSchema = z.strictObject({
  projects: z.array(projectSchema),
});

/** Inferred project create request. */
export type ProjectCreateRequest = z.infer<typeof projectCreateRequestSchema>;
/** Inferred project update request. */
export type ProjectUpdateRequest = z.infer<typeof projectUpdateRequestSchema>;
/** Inferred project summary. */
export type Project = z.infer<typeof projectSchema>;
/** Inferred project list. */
export type ProjectList = z.infer<typeof projectListSchema>;
