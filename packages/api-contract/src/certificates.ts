import { z } from "zod";
import { secretNameSchema, ulidSchema } from "./ids.js";
import { capabilityFlagsSchema } from "./rbac.js";
import { secretTagsSchema } from "./secrets.js";

/** A certificate name; identical to the secret-name allowlist. */
export const certificateNameSchema = secretNameSchema;

/** Certificate tags; identical bounds to secret tags. */
export const certificateTagsSchema = secretTagsSchema;

/** Supported self-signed key profiles. */
export const CERTIFICATE_KEY_TYPES = ["rsa-2048", "rsa-3072", "ec-p256"] as const;

/** One supported key profile. */
export const certificateKeyTypeSchema = z.enum(CERTIFICATE_KEY_TYPES);

/**
 * One typed subject alternative name.
 *
 * The prefix is one of `DNS:`, `IP:`, `URI:`, or `email:`. The server performs the precise
 * DNS, IP, URI, and email checks; the contract enforces the typed form and bounds.
 */
export const certificateSanSchema = z
  .string()
  .min(4)
  .max(2_048)
  .refine((value) => !/\p{Cc}/u.test(value), "control characters are not allowed")
  .refine((value) => /^(DNS|IP|URI|email):/.test(value), "SAN must use a typed prefix")
  .refine((value) => value.slice(value.indexOf(":") + 1).length > 0, "SAN value is required");

/** A self-signed subject distinguished name. */
export const certificateSubjectSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !/\p{Cc}/u.test(value), "control characters are not allowed")
  .refine((value) => value.includes("="), "subject must be an RFC 4514 distinguished name");

/** One non-fatal import warning. */
export const certificateWarningSchema = z.strictObject({
  code: z.enum([
    "expired",
    "not_yet_valid",
    "missing_intermediate",
    "expired_intermediate",
    "not_yet_valid_intermediate",
  ]),
  message: z.string().min(1).max(256),
});

/** Request body for importing a certificate and private key. */
export const certificateImportRequestSchema = z.strictObject({
  name: certificateNameSchema,
  certificatePem: z.string().min(1).max(262_144),
  chainPem: z.string().max(262_144).optional(),
  privateKeyPem: z.string().min(1).max(65_536),
  allowNotYetValid: z.boolean().default(false),
  expectedVersionId: ulidSchema.optional(),
  tags: certificateTagsSchema.optional(),
});

/** Request body for generating a self-signed certificate. */
export const certificateGenerateRequestSchema = z.strictObject({
  name: certificateNameSchema,
  subject: certificateSubjectSchema,
  sans: z.array(certificateSanSchema).min(1).max(100),
  keyType: certificateKeyTypeSchema.default("ec-p256"),
  validityDays: z.number().int().min(1).max(825).default(365),
  expectedVersionId: ulidSchema.optional(),
  tags: certificateTagsSchema.optional(),
});

/** One immutable certificate version identity. */
export const certificateVersionSchema = z.strictObject({
  id: ulidSchema,
  createdAt: z.iso.datetime(),
  createdBy: ulidSchema,
  notBefore: z.iso.datetime(),
  notAfter: z.iso.datetime(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/, "Invalid fingerprint"),
  serial: z.string().min(1).max(128),
});

/** Certificate metadata; contains no PEM body and no private key. */
export const certificateMetadataSchema = z.strictObject({
  id: ulidSchema,
  projectId: ulidSchema,
  name: certificateNameSchema,
  tags: certificateTagsSchema,
  status: z.enum(["active", "expired", "deleted"]),
  subject: z.string().max(1_024),
  sans: z.array(certificateSanSchema),
  issuer: z.string().max(1_024),
  serial: z.string().min(1).max(128),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/, "Invalid fingerprint"),
  notBefore: z.iso.datetime(),
  notAfter: z.iso.datetime(),
  daysToExpiry: z.number().int(),
  chainLength: z.number().int().min(1),
  version: certificateVersionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
  purgeAfter: z.iso.datetime().nullable(),
  purgeProtected: z.boolean(),
  capabilities: capabilityFlagsSchema,
});

/** Import/generate/renew response: metadata plus the public material and warnings. */
export const certificateWriteResponseSchema = certificateMetadataSchema.extend({
  certificatePem: z.string().min(1),
  chainPem: z.string(),
  warnings: z.array(certificateWarningSchema),
});

/** Public chain read: metadata plus the leaf and non-leaf blocks. */
export const certificatePublicResponseSchema = certificateMetadataSchema.extend({
  certificatePem: z.string().min(1),
  chainPem: z.string(),
});

/** Sensitive private-key read. */
export const certificatePrivateKeyResponseSchema = z.strictObject({
  id: ulidSchema,
  projectId: ulidSchema,
  name: certificateNameSchema,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/, "Invalid fingerprint"),
  privateKeyPem: z.string().min(1),
  version: certificateVersionSchema,
  capabilities: capabilityFlagsSchema,
});

/** Query for one certificate version. */
export const certificateReadQuerySchema = z.strictObject({
  version: ulidSchema.optional(),
});

/** Query filters for the certificate list. */
export const certificateListQuerySchema = z
  .strictObject({
    q: z
      .string()
      .min(1)
      .max(1_024)
      .refine((value) => !/\p{Cc}/u.test(value), "control characters are not allowed")
      .optional(),
    san: certificateSanSchema.optional(),
    expiresBefore: z.iso.datetime().optional(),
    expiresAfter: z.iso.datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/, "Invalid cursor")
      .optional(),
  })
  .refine(
    (value) =>
      value.expiresBefore === undefined ||
      value.expiresAfter === undefined ||
      Date.parse(value.expiresAfter) <= Date.parse(value.expiresBefore),
    { path: ["expiresAfter"], message: "expiresAfter must not be after expiresBefore" },
  );

/** One page of certificate metadata. */
export const certificateListSchema = z.strictObject({
  certificates: z.array(certificateMetadataSchema),
  nextCursor: z.string().nullable(),
});

/** Metadata-only changes. */
export const certificateMetadataUpdateRequestSchema = z
  .strictObject({
    tags: certificateTagsSchema.optional(),
    purgeProtected: z.boolean().optional(),
  })
  .refine(
    (value) => value.tags !== undefined || value.purgeProtected !== undefined,
    "at least one field is required",
  );

/** Inferred certificate key profile. */
export type CertificateKeyType = z.infer<typeof certificateKeyTypeSchema>;
/** Inferred import request. */
export type CertificateImportRequest = z.infer<typeof certificateImportRequestSchema>;
/** Inferred raw import input before defaults. */
export type CertificateImportInput = z.input<typeof certificateImportRequestSchema>;
/** Inferred generate request. */
export type CertificateGenerateRequest = z.infer<typeof certificateGenerateRequestSchema>;
/** Inferred raw generate input before defaults. */
export type CertificateGenerateInput = z.input<typeof certificateGenerateRequestSchema>;
/** Inferred certificate version. */
export type CertificateVersion = z.infer<typeof certificateVersionSchema>;
/** Inferred metadata. */
export type CertificateMetadata = z.infer<typeof certificateMetadataSchema>;
/** Inferred write response. */
export type CertificateWriteResponse = z.infer<typeof certificateWriteResponseSchema>;
/** Inferred public response. */
export type CertificatePublicResponse = z.infer<typeof certificatePublicResponseSchema>;
/** Inferred private-key response. */
export type CertificatePrivateKeyResponse = z.infer<typeof certificatePrivateKeyResponseSchema>;
/** Inferred read query. */
export type CertificateReadQuery = z.infer<typeof certificateReadQuerySchema>;
/** Inferred list query. */
export type CertificateListQuery = z.infer<typeof certificateListQuerySchema>;
/** Inferred list response. */
export type CertificateList = z.infer<typeof certificateListSchema>;
/** Inferred metadata update. */
export type CertificateMetadataUpdateRequest = z.infer<
  typeof certificateMetadataUpdateRequestSchema
>;
/** Inferred warning. */
export type CertificateWarning = z.infer<typeof certificateWarningSchema>;
