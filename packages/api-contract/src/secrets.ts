import { z } from "zod";
import { secretNameSchema, ulidSchema } from "./ids.js";
import { capabilityFlagsSchema } from "./rbac.js";

/** Supported secret value encodings. */
export const SECRET_ENCODINGS = ["utf8", "base64"] as const;

/** One supported secret value encoding. */
export const secretEncodingSchema = z.enum(SECRET_ENCODINGS);

/** Content type stored with a secret. */
export const secretContentTypeSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/\p{Cc}/u.test(value), "control characters are not allowed");

/** One tag key. */
export const secretTagKeySchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !/\p{Cc}/u.test(value), "control characters are not allowed");

/** One tag value. */
export const secretTagValueSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/\p{Cc}/u.test(value), "control characters are not allowed");

/** Up to fifteen secret tags. */
export const secretTagsSchema = z
  .record(secretTagKeySchema, secretTagValueSchema)
  .refine((value) => Object.keys(value).length <= 15, "at most fifteen tags are allowed");

/** One immutable version identity. */
export const secretVersionSchema = z.strictObject({
  id: ulidSchema,
  createdAt: z.iso.datetime(),
  createdBy: ulidSchema,
  expiresAt: z.iso.datetime().nullable(),
});

/** One version in a history list. */
export const secretVersionSummarySchema = secretVersionSchema.extend({
  status: z.enum(["active", "expired"]),
  isCurrent: z.boolean(),
});

/** One consumer summary attached to secret metadata. */
export const secretConsumerSummarySchema = z.strictObject({
  composeProject: z.string().min(1).max(100),
  composeService: z.string().min(1).max(100),
  lastSeen: z.iso.datetime(),
});

/** Secret metadata returned by list, create, write, and recover. */
export const secretMetadataSchema = z.strictObject({
  id: ulidSchema,
  projectId: ulidSchema,
  name: secretNameSchema,
  tags: secretTagsSchema,
  contentType: secretContentTypeSchema,
  status: z.enum(["active", "deleted"]),
  currentVersion: secretVersionSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
  purgeAfter: z.iso.datetime().nullable(),
  purgeProtected: z.boolean(),
  consumers: z.array(secretConsumerSummarySchema),
  capabilities: capabilityFlagsSchema,
});

/** Metadata plus the exact version written or replayed. */
export const secretWriteResponseSchema = secretMetadataSchema.extend({
  version: secretVersionSchema,
});

/** Request body for creating a secret. */
export const secretCreateRequestSchema = z.strictObject({
  name: secretNameSchema,
  value: z.string(),
  encoding: secretEncodingSchema.default("utf8"),
  contentType: secretContentTypeSchema.default("text/plain"),
  tags: secretTagsSchema.default({}),
  expiresAt: z.iso.datetime().optional(),
});

/** Request body for writing a new value version. */
export const secretValueWriteRequestSchema = z.strictObject({
  value: z.string(),
  encoding: secretEncodingSchema.default("utf8"),
  expiresAt: z.iso.datetime().optional(),
});

/** Request body for metadata-only changes. */
export const secretMetadataUpdateRequestSchema = z
  .strictObject({
    tags: secretTagsSchema.optional(),
    contentType: secretContentTypeSchema.optional(),
    purgeProtected: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.tags !== undefined ||
      value.contentType !== undefined ||
      value.purgeProtected !== undefined,
    "at least one field is required",
  );

/** Query for a value read. */
export const secretReadQuerySchema = z.strictObject({
  version: ulidSchema.optional(),
});

/** Query for the secret list. */
export const secretListQuerySchema = z
  .strictObject({
    q: z
      .string()
      .min(1)
      .max(127)
      .refine((value) => !/\p{Cc}/u.test(value), "control characters are not allowed")
      .optional(),
    tagKey: secretTagKeySchema.optional(),
    tagValue: secretTagValueSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/, "Invalid cursor")
      .optional(),
  })
  .refine((value) => value.tagValue === undefined || value.tagKey !== undefined, {
    path: ["tagKey"],
    message: "tagKey is required when tagValue is supplied",
  });

/** One page of secrets. */
export const secretListSchema = z.strictObject({
  secrets: z.array(secretMetadataSchema),
  nextCursor: z.string().nullable(),
});

/** Value response; the only response that contains a value. */
export const secretValueResponseSchema = z.strictObject({
  id: ulidSchema,
  projectId: ulidSchema,
  name: secretNameSchema,
  value: z.string(),
  encoding: secretEncodingSchema,
  contentType: secretContentTypeSchema,
  tags: secretTagsSchema,
  version: secretVersionSchema,
  capabilities: capabilityFlagsSchema,
});

/** Version history response. */
export const secretVersionListSchema = z.strictObject({
  versions: z.array(secretVersionSummarySchema),
});

/** Consumer list response. */
export const secretConsumerListSchema = z.strictObject({
  consumers: z.array(secretConsumerSummarySchema),
});

/** Inferred secret encoding. */
export type SecretEncoding = z.infer<typeof secretEncodingSchema>;
/** Inferred secret version. */
export type SecretVersion = z.infer<typeof secretVersionSchema>;
/** Inferred version summary. */
export type SecretVersionSummary = z.infer<typeof secretVersionSummarySchema>;
/** Inferred consumer summary. */
export type SecretConsumerSummary = z.infer<typeof secretConsumerSummarySchema>;
/** Inferred secret metadata. */
export type SecretMetadata = z.infer<typeof secretMetadataSchema>;
/** Inferred write response. */
export type SecretWriteResponse = z.infer<typeof secretWriteResponseSchema>;
/** Inferred create request. */
export type SecretCreateRequest = z.infer<typeof secretCreateRequestSchema>;
/** Inferred value write request. */
export type SecretValueWriteRequest = z.infer<typeof secretValueWriteRequestSchema>;
/** Inferred metadata update request. */
export type SecretMetadataUpdateRequest = z.infer<typeof secretMetadataUpdateRequestSchema>;
/** Inferred value read query. */
export type SecretReadQuery = z.infer<typeof secretReadQuerySchema>;
/** Inferred list query. */
export type SecretListQuery = z.infer<typeof secretListQuerySchema>;
/** Inferred list response. */
export type SecretList = z.infer<typeof secretListSchema>;
/** Inferred value response. */
export type SecretValueResponse = z.infer<typeof secretValueResponseSchema>;
/** Inferred version list. */
export type SecretVersionList = z.infer<typeof secretVersionListSchema>;
/** Inferred consumer list. */
export type SecretConsumerList = z.infer<typeof secretConsumerListSchema>;
