import { AUDIT_ACTIONS, type AuditAction, RBAC_ACTIONS } from "@openvault/api-contract";
import { isPlainObject } from "./canonical-json.js";
import { AuditInputError } from "./errors.js";

/** Largest accepted string value inside `details`. */
const MAX_DETAIL_STRING = 1_024;

/** Largest accepted encoded size for one `details` object. */
const MAX_DETAILS_BYTES = 16 * 1_024;

/** Largest accepted nesting depth for the nested `filters` object. */
const MAX_FILTER_DEPTH = 2;

/** Every action accepted by the query schema and the writer. */
export const AUDIT_ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

/** The fixed policy actions, used to select the policy-details allowlist. */
const POLICY_ACTIONS: ReadonlySet<string> = new Set(RBAC_ACTIONS);

/** Details keys permitted on authorization decisions and policy operations. */
const POLICY_DETAIL_KEYS: ReadonlySet<string> = new Set([
  "reason",
  "policyVersion",
  "denialCount",
  "version",
  "kekId",
]);

/** Details keys permitted on authentication success and failure events. */
const LOGIN_DETAIL_KEYS: ReadonlySet<string> = new Set(["method", "client", "reason"]);

/** Details keys permitted on lockout events. */
const LOCKOUT_DETAIL_KEYS: ReadonlySet<string> = new Set(["method", "client", "lockSeconds"]);

/** Details keys permitted on agent join and renewal events. */
const AGENT_DETAIL_KEYS: ReadonlySet<string> = new Set([
  "reason",
  "consumerId",
  "certificateSerial",
]);

/** Details keys permitted on consumer registration and update events. */
const CONSUMER_DETAIL_KEYS: ReadonlySet<string> = new Set([
  "consumerId",
  "composeProject",
  "composeService",
  "hostname",
  "manifestHash",
  "state",
  "changed",
]);

/** Details keys permitted on assignment mutation events. */
const ASSIGNMENT_DETAIL_KEYS: ReadonlySet<string> = new Set([
  "assignmentId",
  "targetPrincipalId",
  "role",
  "policyVersion",
]);

/** Details keys permitted on audit verification events. */
const VERIFY_DETAIL_KEYS: ReadonlySet<string> = new Set([
  "ok",
  "checkedFromEventId",
  "checkedToEventId",
  "firstBrokenEventId",
  "reason",
]);

/** Details keys permitted on audit export events. */
const EXPORT_DETAIL_KEYS: ReadonlySet<string> = new Set(["format", "filters"]);

/** Details keys permitted on audit prune events. */
const PRUNE_DETAIL_KEYS: ReadonlySet<string> = new Set([
  "cutoff",
  "exportedCount",
  "deletedCount",
  "checkpointId",
  "dryRun",
]);

/** Details keys permitted on backup events. */
const BACKUP_DETAIL_KEYS: ReadonlySet<string> = new Set(["format", "objectCount"]);

/** Query filter keys accepted inside `details.filters`. */
const FILTER_KEYS: ReadonlySet<string> = new Set([
  "from",
  "to",
  "actorId",
  "action",
  "objectType",
  "objectId",
  "result",
  "requestId",
  "projectId",
]);

/**
 * Returns the details keys permitted for one action.
 *
 * Unknown keys are rejected before hashing, so secret material and future
 * free-form fields cannot enter the append-only log by accident.
 *
 * @param action - Frozen audit action.
 * @returns The permitted key set.
 */
export function allowedDetailKeys(action: AuditAction): ReadonlySet<string> {
  switch (action) {
    case "auth.login":
      return LOGIN_DETAIL_KEYS;
    case "auth.lockout":
      return LOCKOUT_DETAIL_KEYS;
    case "agent.join":
    case "agent.renew":
      return AGENT_DETAIL_KEYS;
    case "consumer.register":
    case "consumer.update":
      return CONSUMER_DETAIL_KEYS;
    case "assignment.grant":
    case "assignment.revoke":
      return ASSIGNMENT_DETAIL_KEYS;
    case "audit.verify":
      return VERIFY_DETAIL_KEYS;
    case "audit.export":
      return EXPORT_DETAIL_KEYS;
    case "audit.prune":
      return PRUNE_DETAIL_KEYS;
    case "backup.create":
      return BACKUP_DETAIL_KEYS;
    default:
      if (POLICY_ACTIONS.has(action)) {
        return POLICY_DETAIL_KEYS;
      }
      throw new AuditInputError(`Unknown audit action: ${action}`);
  }
}

/** Validates one nested filter object. */
function validateFilters(value: Record<string, unknown>): void {
  for (const [key, entry] of Object.entries(value)) {
    if (!FILTER_KEYS.has(key)) {
      throw new AuditInputError(`Unknown filter key: ${key}`);
    }
    if (
      entry !== null &&
      typeof entry !== "string" &&
      typeof entry !== "number" &&
      typeof entry !== "boolean"
    ) {
      throw new AuditInputError(`Filter ${key} must be a primitive value`);
    }
    if (typeof entry === "string") {
      if (entry.includes("\u0000")) {
        throw new AuditInputError(`Filter ${key} contains a null character`);
      }
      if (entry.length > MAX_DETAIL_STRING) {
        throw new AuditInputError(`Filter ${key} exceeds the string bound`);
      }
    }
  }
}

/** Validates one details value against the permitted shape for its key. */
function validateDetailValue(key: string, value: unknown, depth: number): void {
  if (value === null || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AuditInputError(`Detail ${key} must be a finite number`);
    }
    return;
  }
  if (typeof value === "string") {
    if (value.includes("\u0000")) {
      throw new AuditInputError(`Detail ${key} contains a null character`);
    }
    if (value.length > MAX_DETAIL_STRING) {
      throw new AuditInputError(`Detail ${key} exceeds the string bound`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (key !== "changed") {
      throw new AuditInputError(`Detail ${key} must not be an array`);
    }
    for (const entry of value) {
      if (
        typeof entry !== "string" ||
        entry.includes("\u0000") ||
        entry.length > MAX_DETAIL_STRING
      ) {
        throw new AuditInputError("Detail changed must contain bounded strings");
      }
    }
    return;
  }
  if (isPlainObject(value)) {
    if (key !== "filters" || depth >= MAX_FILTER_DEPTH) {
      throw new AuditInputError(`Detail ${key} must not contain a nested object`);
    }
    validateFilters(value);
    return;
  }
  throw new AuditInputError(`Detail ${key} has an unsupported value`);
}

/**
 * Validates one event's action-specific details.
 *
 * The whole object is rejected when any key is outside the action allowlist,
 * a value has the wrong shape, or the encoded object exceeds the bound.
 *
 * @param action - Frozen audit action.
 * @param details - Detail object supplied by the emitter.
 * @throws {AuditInputError} When the details cannot be stored safely.
 */
export function validateDetails(
  action: AuditAction,
  details: Readonly<Record<string, unknown>>,
): void {
  if (!isPlainObject(details)) {
    throw new AuditInputError("Details must be an object");
  }
  const allowed = allowedDetailKeys(action);
  for (const [key, value] of Object.entries(details)) {
    if (!allowed.has(key)) {
      throw new AuditInputError(`Detail ${key} is not allowed for ${action}`);
    }
    validateDetailValue(key, value, 1);
  }

  let encoded: string;
  try {
    encoded = JSON.stringify(details);
  } catch {
    throw new AuditInputError("Details cannot be serialized");
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_DETAILS_BYTES) {
    throw new AuditInputError("Details exceed the encoded size bound");
  }
}
