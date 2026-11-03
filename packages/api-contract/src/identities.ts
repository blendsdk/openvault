import { z } from "zod";
import { ulidSchema } from "./ids.js";

/**
 * A service-identity name.
 *
 * Names are trimmed, 1–100 characters, and may contain Unicode text. Control
 * characters are rejected. Names are case-sensitive and unique among active
 * service identities in the same project.
 *
 * @example
 * ```ts
 * identityNameSchema.parse("payments-api");
 * ```
 */
export const identityNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !/\p{Cc}/u.test(value), "control characters are not allowed");

/**
 * Request body for creating a service identity.
 *
 * The project is optional at the schema layer so the service can return the
 * documented validation error when it is missing or inactive.
 */
export const identityCreateRequestSchema = z.strictObject({
  name: identityNameSchema,
  projectId: ulidSchema.optional(),
});

/** Query parameters for the scoped service-identity list. */
export const identityListQuerySchema = z.strictObject({
  projectId: ulidSchema.optional(),
});

/** Public summary of one service identity. */
export const identitySummarySchema = z.strictObject({
  id: ulidSchema,
  name: z.string().min(1).max(100),
  projectId: ulidSchema,
  status: z.enum(["active", "disabled"]),
  createdAt: z.iso.datetime(),
});

/**
 * One retained workload certificate.
 *
 * Revoked and expired rows are still returned in identity detail so operators
 * can see certificate history.
 */
export const identityCertificateSchema = z.strictObject({
  serial: z.string().min(1).max(128),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  notBefore: z.iso.datetime(),
  notAfter: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});

/** Last consumer metadata reported by the agent. */
export const identityConsumerSchema = z.strictObject({
  composeProject: z.string().min(1).max(100),
  composeService: z.string().min(1).max(100),
  hostname: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/),
  manifestHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  state: z.enum(["ok", "degraded", "failed"]),
  firstSeen: z.iso.datetime(),
  lastSeen: z.iso.datetime(),
  selfReported: z.literal(true),
});

/** Identity detail including retained certificates and consumer metadata. */
export const identityDetailSchema = identitySummarySchema.extend({
  certificates: z.array(identityCertificateSchema),
  consumer: identityConsumerSchema.nullable(),
});

/** Scoped service-identity list response. */
export const identityListSchema = z.strictObject({
  identities: z.array(identitySummarySchema),
});

/**
 * Optional lifetime for a one-time join token.
 *
 * The contract accepts any integer. The service enforces the 1–86,400 second
 * range and maps an out-of-range value to a semantic validation error.
 */
export const joinTokenCreateRequestSchema = z.strictObject({
  ttlSeconds: z.number().int().optional(),
});

/** One-time join-token response; the raw token is returned exactly once. */
export const joinTokenResponseSchema = z.strictObject({
  id: ulidSchema,
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime(),
});

/** Inferred service-identity create request. */
export type IdentityCreateRequest = z.infer<typeof identityCreateRequestSchema>;

/** Inferred service-identity list query. */
export type IdentityListQuery = z.infer<typeof identityListQuerySchema>;

/** Inferred service-identity summary. */
export type IdentitySummary = z.infer<typeof identitySummarySchema>;

/** Inferred retained certificate summary. */
export type IdentityCertificate = z.infer<typeof identityCertificateSchema>;

/** Inferred consumer metadata summary. */
export type IdentityConsumer = z.infer<typeof identityConsumerSchema>;

/** Inferred service-identity detail. */
export type IdentityDetail = z.infer<typeof identityDetailSchema>;

/** Inferred service-identity list response. */
export type IdentityList = z.infer<typeof identityListSchema>;

/** Inferred join-token request. */
export type JoinTokenCreateRequest = z.infer<typeof joinTokenCreateRequestSchema>;

/** Inferred join-token response. */
export type JoinTokenResponse = z.infer<typeof joinTokenResponseSchema>;
