import { newUlid } from "@openvault/core";
import {
  DenialCounter,
  type PolicyAuditPort,
  type PolicyDecisionEvent,
  type PolicyMutationEvent,
} from "../rbac/audit.js";
import type { AuditWriter } from "./audit-writer.js";
import type { AuditEventDraft, AuditEventInput, AuditQueryExecutor } from "./types.js";

/** Persistent implementation of the policy audit boundary. */
export class PersistentPolicyAudit implements PolicyAuditPort {
  readonly #writer: AuditWriter;
  readonly #now: () => number;
  readonly #database: AuditQueryExecutor | undefined;
  readonly #denials = new DenialCounter();

  /**
   * @param options - Chain writer, optional database for reference checks, and clock.
   */
  public constructor(options: {
    readonly writer: AuditWriter;
    readonly database?: AuditQueryExecutor;
    readonly now?: () => number;
  }) {
    this.#writer = options.writer;
    this.#database = options.database;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Records one decision.
   *
   * A supplied transaction normally writes through the independent audit pool
   * so the decision survives a later rollback. Pass `{ independent: false }`
   * when the caller takes the chain lock and joins the decision to its
   * transaction.
   *
   * @param event - Decision to persist.
   * @param tx - Caller transaction.
   * @param options - Independence override.
   */
  public async recordDecision(
    event: PolicyDecisionEvent,
    tx?: AuditQueryExecutor,
    options?: { readonly independent?: boolean },
  ): Promise<void> {
    const denialCount =
      event.result === "deny"
        ? (event.denialCount ?? this.#denials.increment(event.actorId))
        : undefined;
    let projectId = event.projectId;
    let scopeType = event.scopeType;
    let scopeId = event.scopeId;
    if (projectId !== null && !(await this.#projectExists(projectId, tx))) {
      // A decision about an unknown project cannot satisfy the project foreign
      // key. Persist it at system scope with the requested object identity so
      // the denial still reaches the log instead of turning into an outage.
      projectId = null;
      scopeType = "system";
      scopeId = null;
    }
    const details: Record<string, string | number> = {
      reason: event.reason,
      policyVersion: event.policyVersion,
    };
    if (denialCount !== undefined) {
      details.denialCount = denialCount;
    }
    for (const [key, value] of Object.entries(event.details ?? {})) {
      details[key] = value;
    }
    const draft: AuditEventInput = {
      eventId: newUlid(),
      ts: new Date(this.#now()),
      projectId,
      requestId: event.context?.requestId ?? "internal",
      actorId: event.actorId,
      actorKind: event.actorKind,
      action: event.action,
      scopeType,
      scopeId,
      objectType: event.objectType,
      objectId: event.objectId,
      result: event.result,
      sourceIp: event.context?.sourceIp ?? null,
      userAgent: event.context?.userAgent ?? null,
      details,
    };
    if (tx === undefined || options?.independent !== false) {
      if (tx === undefined) {
        await this.#writer.record(draft);
      } else {
        await this.#writer.recordIndependent(draft);
      }
    } else {
      await this.#writer.record(draft, tx);
    }
  }

  /** @inheritDoc */
  public async recordMutation(event: PolicyMutationEvent, tx?: AuditQueryExecutor): Promise<void> {
    const draft: AuditEventDraft = {
      projectId: event.projectId,
      requestId: event.context?.requestId ?? "internal",
      actorId: event.actorId,
      actorKind: event.actorKind,
      action: event.action,
      scopeType: event.scopeType,
      scopeId: event.scopeId,
      objectType: "assignment",
      objectId: event.assignmentId,
      result: event.result,
      sourceIp: event.context?.sourceIp ?? null,
      userAgent: event.context?.userAgent ?? null,
      details: {
        assignmentId: event.assignmentId,
        targetPrincipalId: event.targetPrincipalId,
        role: event.role,
        policyVersion: event.policyVersion,
      },
    };
    await this.#writer.record({ ...draft, eventId: newUlid(), ts: new Date(this.#now()) }, tx);
  }

  /** Returns true when a project row exists, including a soft-deleted row. */
  async #projectExists(projectId: string, tx: AuditQueryExecutor | undefined): Promise<boolean> {
    const executor = tx ?? this.#database;
    if (executor === undefined) {
      return true;
    }
    const result = await executor.executeQuery<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM projects WHERE id = :projectId) AS present",
      { projectId },
    );
    return result.records[0]?.present === true;
  }
}
