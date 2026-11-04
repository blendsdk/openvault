import type { AuditAction } from "@openvault/api-contract";

/** Actor classes stored in `audit_events.actor_kind`. */
export type AuditActorKind = "user" | "service" | "system";

/** Stored outcome classes. */
export type AuditResult = "allow" | "deny" | "error";

/** Stored scope classes. */
export type AuditScopeType = "org" | "project" | "object" | "system";

/** Request metadata attached to an event when the transport provides it. */
export interface AuditRequestContext {
  /** Correlation id from the request. */
  readonly requestId?: string;
  /** Client address when the transport can provide it. */
  readonly sourceIp?: string;
  /** Client user agent when the transport can provide it. */
  readonly userAgent?: string;
}

/** A value accepted inside `details`. */
export type AuditDetailValue =
  | null
  | boolean
  | number
  | string
  | readonly AuditDetailValue[]
  | { readonly [key: string]: AuditDetailValue };

/** One event before the chain fields are computed. */
export interface AuditEventDraft {
  /** Owning project for project or object scope, otherwise null. */
  readonly projectId: string | null;
  /** Correlation id required on every row. */
  readonly requestId: string;
  /** Acting principal, or null for a system actor. */
  readonly actorId: string | null;
  /** Actor class. */
  readonly actorKind: AuditActorKind;
  /** Frozen action name. */
  readonly action: AuditAction;
  /** Scope class. */
  readonly scopeType: AuditScopeType;
  /** Scope identifier, or null for a system scope. */
  readonly scopeId: string | null;
  /** Resource type, or null when the event is not about one object. */
  readonly objectType: string | null;
  /** Resource identifier, or null when the event is not about one object. */
  readonly objectId: string | null;
  /** Outcome. */
  readonly result: AuditResult;
  /** Client address before PostgreSQL canonicalization, if available. */
  readonly sourceIp: string | null;
  /** Client user agent, truncated to the stored bound. */
  readonly userAgent: string | null;
  /** Action-specific evidence. */
  readonly details: Readonly<Record<string, AuditDetailValue>>;
}

/** One event with its identity and timestamp assigned. */
export interface AuditEventInput extends AuditEventDraft {
  /** Unique ULID for the event. */
  readonly eventId: string;
  /** Event time; the writer stores this exact millisecond value. */
  readonly ts: Date;
}

/** One persisted event, including its sequence position and chain fields. */
export interface AuditEventRecord extends AuditEventInput {
  /** `audit_events.id`; a decimal bigint string. */
  readonly sequenceId: string;
  /** Hash of the previous event, or 32 zero bytes for the first event. */
  readonly prevHash: Buffer;
  /** SHA-256 chain hash. */
  readonly hash: Buffer;
  /** HMAC-SHA256 of the chain hash. */
  readonly hmac: Buffer;
  /** Key used to compute the HMAC. */
  readonly auditKeyId: string;
}

/**
 * Minimal database or transaction surface used by audit persistence.
 *
 * The audit modules depend on this narrow contract instead of importing an
 * unrelated repository layer. `PostgreSQLDatabase` satisfies it directly, and
 * transaction callbacks satisfy it through their transaction handle. A value
 * passed as a transaction must be the callback handle, not the outer database,
 * and that transaction must use READ COMMITTED isolation so the writer sees
 * the latest committed chain tail after taking its advisory lock.
 */
export interface AuditQueryExecutor {
  /** Executes one named-parameter query. */
  executeQuery<T>(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<{ readonly records: readonly T[] }>;
}
