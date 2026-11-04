import { z } from "zod";
import { ulidSchema } from "./ids.js";
import { RBAC_ACTIONS } from "./rbac.js";

/** Actions that are not part of the fixed authorization action catalog. */
export const BUSINESS_AUDIT_ACTIONS = [
  "auth.login",
  "auth.lockout",
  "assignment.grant",
  "assignment.revoke",
  "agent.join",
  "agent.renew",
  "consumer.register",
  "consumer.update",
  "audit.verify",
  "audit.export",
  "audit.prune",
  "backup.create",
  "certificate.expiry_warning",
] as const;

/**
 * Every authorization action plus the business audit actions.
 *
 * Query filters and the writer share this closed catalog so an event cannot be
 * recorded under a name that the API cannot filter.
 *
 * @example
 * ```ts
 * AUDIT_ACTIONS.includes("identity.create");
 * ```
 */
export const AUDIT_ACTIONS = [...RBAC_ACTIONS, ...BUSINESS_AUDIT_ACTIONS] as const;

/** One action accepted by the audit API and writer. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** A lowercase hexadecimal SHA-256 digest. */
export const hexHashSchema = z.string().regex(/^[0-9a-f]{64}$/, "Invalid hexadecimal hash");

/**
 * One stored event as returned by the API.
 *
 * Organization and system scopes have a null `projectId`; a system scope also
 * has a null `scopeId`. An `actorKind` of `system` has a null `actorId`, while
 * a user or service actor can appear on a system-scope business event.
 */
export const auditEventSchema = z.strictObject({
  eventId: ulidSchema,
  ts: z.iso.datetime(),
  projectId: ulidSchema.nullable(),
  requestId: z.string().min(1).max(100),
  actorId: ulidSchema.nullable(),
  actorKind: z.enum(["user", "service", "system"]),
  action: z.enum(AUDIT_ACTIONS),
  scopeType: z.enum(["org", "project", "object", "system"]),
  scopeId: z.string().min(1).max(64).nullable(),
  objectType: z.string().min(1).max(64).nullable(),
  objectId: z.string().min(1).max(64).nullable(),
  result: z.enum(["allow", "deny", "error"]),
  sourceIp: z.string().min(1).max(64).nullable(),
  userAgent: z.string().max(512).nullable(),
  details: z.record(z.string(), z.unknown()),
  prevHash: hexHashSchema,
  hash: hexHashSchema,
  hmac: hexHashSchema,
  auditKeyId: ulidSchema,
});

/** Filter fields shared by the list and export contracts. */
const auditFilterShape = {
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  actorId: ulidSchema.optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  objectType: z.string().min(1).max(64).optional(),
  objectId: z.string().min(1).max(64).optional(),
  result: z.enum(["allow", "deny", "error"]).optional(),
  requestId: z.string().min(1).max(100).optional(),
  projectId: ulidSchema.optional(),
};

/**
 * Applies the checks shared by the list and export filters.
 *
 * An object id without its type is rejected because the existing composite
 * index is ordered by `(object_type, object_id)`; accepting an untyped id would
 * force an unbounded scan.
 */
function validateAuditFilters(
  value: {
    readonly from?: string | undefined;
    readonly to?: string | undefined;
    readonly objectType?: string | undefined;
    readonly objectId?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (
    value.from !== undefined &&
    value.to !== undefined &&
    Date.parse(value.from) > Date.parse(value.to)
  ) {
    context.addIssue({ code: "custom", path: ["from"], message: "from must not be after to" });
  }
  if (value.objectId !== undefined && value.objectType === undefined) {
    context.addIssue({
      code: "custom",
      path: ["objectType"],
      message: "objectType is required when objectId is supplied",
    });
  }
}

/** Query filters for the event list. */
export const auditQuerySchema = z
  .strictObject({
    ...auditFilterShape,
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: z.string().min(1).max(2_048).optional(),
  })
  .superRefine(validateAuditFilters);

/** Export filters; export streams the full matching range and has no limit or cursor. */
export const auditExportQuerySchema = z
  .strictObject(auditFilterShape)
  .superRefine(validateAuditFilters);

/** The ordered filter keys shared by the cursor hash and export evidence. */
const FILTER_KEYS = [
  "from",
  "to",
  "actorId",
  "action",
  "objectType",
  "objectId",
  "result",
  "requestId",
  "projectId",
] as const;

/**
 * Returns only the filter keys with defined values.
 *
 * The result binds a cursor and supplies the `audit.export` details; it never
 * contains `limit`, `cursor`, or an undefined key.
 *
 * @param input - Parsed or partially parsed query filters.
 * @returns A deterministic filter object.
 */
export function normalizeAuditFilters(input: {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly actorId?: string | undefined;
  readonly action?: string | undefined;
  readonly objectType?: string | undefined;
  readonly objectId?: string | undefined;
  readonly result?: string | undefined;
  readonly requestId?: string | undefined;
  readonly projectId?: string | undefined;
}): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const value = input[key];
    if (value !== undefined) {
      normalized[key] = value;
    }
  }
  return normalized;
}

/** One page of events. */
export const auditEventListSchema = z.strictObject({
  events: z.array(auditEventSchema),
  nextCursor: z.string().nullable(),
});

/** Stable reasons reported by a chain verification. */
export const AUDIT_VERIFY_REASONS = [
  "ok",
  "empty_chain",
  "missing_checkpoint",
  "checkpoint_mismatch",
  "prev_hash_mismatch",
  "hash_mismatch",
  "hmac_mismatch",
  "key_unavailable",
  "tail_truncated",
] as const;

/** One chain verification result. */
export const auditVerifyResponseSchema = z.strictObject({
  ok: z.boolean(),
  checkedRange: z
    .strictObject({
      fromEventId: ulidSchema.nullable(),
      toEventId: ulidSchema.nullable(),
    })
    .nullable(),
  firstBrokenEventId: ulidSchema.nullable(),
  reason: z.enum(AUDIT_VERIFY_REASONS),
});

/** One stored event as returned by the API. */
export type AuditEvent = z.infer<typeof auditEventSchema>;
/** Query filters for the event list. */
export type AuditQuery = z.infer<typeof auditQuerySchema>;
/** Query filters for export. */
export type AuditExportQuery = z.infer<typeof auditExportQuerySchema>;
/** One page of events. */
export type AuditEventList = z.infer<typeof auditEventListSchema>;
/** One chain verification result. */
export type AuditVerifyResponse = z.infer<typeof auditVerifyResponseSchema>;
/** Stable reason reported by a chain verification. */
export type AuditVerifyReason = (typeof AUDIT_VERIFY_REASONS)[number];
