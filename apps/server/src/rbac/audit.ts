import type { RbacAction, RbacRole, RbacScopeType } from "@openvault/api-contract";
import type { Logger } from "blendsdk/webafx";
import type { AuditQueryExecutor } from "../audit/types.js";
import type { DecisionReason } from "./reasons.js";

/** Maximum principals retained by the process-local denial counter. */
const DENIAL_COUNTER_LIMIT = 1_024;

/** Bounded process-local per-principal denial counter. */
export class DenialCounter {
  readonly #counts = new Map<string, number>();

  /**
   * Increments and returns the denial count for one actor.
   *
   * The oldest actor is evicted when the bound is reached, so memory cannot
   * grow without limit under a denial flood.
   *
   * @param actorId - Principal identifier.
   * @returns The new count.
   */
  public increment(actorId: string): number {
    const current = this.#counts.get(actorId) ?? 0;
    if (!this.#counts.has(actorId) && this.#counts.size >= DENIAL_COUNTER_LIMIT) {
      const oldest = this.#counts.keys().next().value;
      if (oldest !== undefined) {
        this.#counts.delete(oldest);
      }
    }
    const next = current + 1;
    this.#counts.set(actorId, next);
    return next;
  }
}

/** Request metadata attached to an audit event when available. */
export interface PolicyAuditContext {
  /** Correlation id from the request. */
  readonly requestId?: string;
  /** Client address when the transport can provide it. */
  readonly sourceIp?: string;
  /** Client user agent when the transport can provide it. */
  readonly userAgent?: string;
}

/** One authorization decision event. */
export interface PolicyDecisionEvent {
  /** Actor principal identifier. */
  readonly actorId: string;
  /** Actor kind. */
  readonly actorKind: "user" | "service";
  /** Action that was evaluated. */
  readonly action: RbacAction;
  /** Scope of the decision, or `system` for an any-scope check. */
  readonly scopeType: RbacScopeType | "system";
  /** Scope identifier, or null for a system check. */
  readonly scopeId: string | null;
  /** Owning project for a project or object resource, or null. */
  readonly projectId: string | null;
  /** Resource type, or null for a system check. */
  readonly objectType: "project" | "identity" | "secret" | "certificate" | null;
  /** Resource identifier, or null for a system check. */
  readonly objectId: string | null;
  /** Decision result. */
  readonly result: "allow" | "deny";
  /** Stable reason code. */
  readonly reason: DecisionReason;
  /** Policy version used for the decision. */
  readonly policyVersion: number;
  /** Per-process denial count for this actor, present on denials. */
  readonly denialCount?: number;
  /** Optional request metadata. */
  readonly context?: PolicyAuditContext;
}

/** One successful assignment mutation event. */
export interface PolicyMutationEvent {
  /** Actor principal identifier. */
  readonly actorId: string;
  /** Actor kind; assignment mutations are user-initiated. */
  readonly actorKind: "user";
  /** Mutation action. */
  readonly action: "assignment.grant" | "assignment.revoke";
  /** Assignment row identifier. */
  readonly assignmentId: string;
  /** Principal that received or lost the role. */
  readonly targetPrincipalId: string;
  /** Granted or revoked role. */
  readonly role: RbacRole;
  /** Assignment scope. */
  readonly scopeType: RbacScopeType;
  /** Assignment scope identifier. */
  readonly scopeId: string;
  /** Owning project for a project or object scope, or null for the organization. */
  readonly projectId: string | null;
  /** Mutation result; only successful mutations are recorded. */
  readonly result: "allow";
  /** Stable reason code. */
  readonly reason: "allowed";
  /** Policy version after the mutation. */
  readonly policyVersion: number;
  /** Optional request metadata. */
  readonly context?: PolicyAuditContext;
}

/**
 * Narrow audit boundary for policy evidence.
 *
 * The persistent audit writer replaces the logger adapter without changing
 * callers. Implementations must never receive or emit secret values, private
 * keys, tokens, cookies, CSRs, or request bodies.
 */
export interface PolicyAuditPort {
  /**
   * Records exactly one authorization decision.
   *
   * When a transaction is supplied, the decision commits independently of that
   * transaction so it survives a later rollback. Record it before any event
   * that joins the caller transaction, because the independent write needs the
   * chain lock that the joined event will hold until commit.
   */
  recordDecision(event: PolicyDecisionEvent, tx?: AuditQueryExecutor): Promise<void>;
  /**
   * Records one successful assignment mutation.
   *
   * When a transaction is supplied, the event commits or rolls back with the
   * assignment that produced it.
   */
  recordMutation(event: PolicyMutationEvent, tx?: AuditQueryExecutor): Promise<void>;
}

/** Flattens optional request metadata into the log object. */
function contextFields(context: PolicyAuditContext | undefined): Record<string, string> {
  if (context === undefined) {
    return {};
  }
  return {
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    ...(context.sourceIp === undefined ? {} : { sourceIp: context.sourceIp }),
    ...(context.userAgent === undefined ? {} : { userAgent: context.userAgent }),
  };
}

/**
 * Structured-log audit adapter with a bounded per-principal denial counter.
 *
 * A logger rejection propagates so the policy service can fail closed. The
 * counter is process-local and resets on restart; it exists so abuse detection
 * can read an incrementing value without a second aggregation path.
 */
export class LoggingPolicyAudit implements PolicyAuditPort {
  readonly #logger: Logger;
  readonly #denials = new DenialCounter();

  /**
   * @param logger - Application logger.
   */
  public constructor(logger: Logger) {
    this.#logger = logger;
  }

  /** @inheritDoc */
  public async recordDecision(event: PolicyDecisionEvent, _tx?: AuditQueryExecutor): Promise<void> {
    const denialCount =
      event.result === "deny" ? this.#denials.increment(event.actorId) : undefined;
    // Audit evidence must survive every supported log level. The error channel
    // is emitted at all levels; the payload contains identifiers only.
    await this.#logger.error("policy decision", {
      actorId: event.actorId,
      actorKind: event.actorKind,
      action: event.action,
      scopeType: event.scopeType,
      scopeId: event.scopeId,
      projectId: event.projectId,
      objectType: event.objectType,
      objectId: event.objectId,
      result: event.result,
      reason: event.reason,
      policyVersion: event.policyVersion,
      ...(denialCount === undefined ? {} : { denialCount }),
      ...contextFields(event.context),
    });
  }

  /** @inheritDoc */
  public async recordMutation(event: PolicyMutationEvent, _tx?: AuditQueryExecutor): Promise<void> {
    await this.#logger.error("policy mutation", {
      actorId: event.actorId,
      actorKind: event.actorKind,
      action: event.action,
      assignmentId: event.assignmentId,
      targetPrincipalId: event.targetPrincipalId,
      role: event.role,
      scopeType: event.scopeType,
      scopeId: event.scopeId,
      projectId: event.projectId,
      result: event.result,
      reason: event.reason,
      policyVersion: event.policyVersion,
      ...contextFields(event.context),
    });
  }
}
