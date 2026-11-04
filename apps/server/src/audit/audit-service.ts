import {
  type AuditEventList,
  type AuditExportQuery,
  type AuditQuery,
  type AuditVerifyResponse,
  normalizeAuditFilters,
} from "@openvault/api-contract";
import { newUlid } from "@openvault/core";
import { PolicyUnavailableError } from "../rbac/errors.js";
import type { PolicyDecision, PolicyService } from "../rbac/policy-service.js";
import { type AuditExporter, toPublicEvent } from "./audit-export.js";
import type { AuditEventQuery } from "./audit-query.js";
import type { AuditVerifier } from "./audit-verify.js";
import type { AuditWriter } from "./audit-writer.js";
import { AuditAccessDeniedError, AuditError, AuditUnavailableError } from "./errors.js";
import type {
  AuditEventDraft,
  AuditEventRecord,
  AuditQueryExecutor,
  AuditRequestContext,
  AuditVisibility,
} from "./types.js";

/** Converts unexpected driver failures into the audit service error family. */
function wrap(error: unknown): Error {
  if (error instanceof AuditError || error instanceof PolicyUnavailableError) {
    return error;
  }
  return new AuditUnavailableError("Audit service unavailable", error);
}

/**
 * Facade used by controllers and emitters.
 *
 * It owns authorization, the business event for verify and export, and the
 * mapping from internal records to the public contract. The writer, query,
 * verifier, and exporter remain single-purpose collaborators.
 */
export class AuditService {
  readonly #writer: AuditWriter;
  readonly #query: AuditEventQuery;
  readonly #verifier: AuditVerifier;
  readonly #exporter: AuditExporter;
  readonly #policy: PolicyService;
  readonly #now: () => number;

  /**
   * @param options - Persistence, policy, and clock collaborators.
   */
  public constructor(options: {
    readonly writer: AuditWriter;
    readonly query: AuditEventQuery;
    readonly verifier: AuditVerifier;
    readonly exporter: AuditExporter;
    readonly policy: PolicyService;
    readonly now?: () => number;
  }) {
    this.#writer = options.writer;
    this.#query = options.query;
    this.#verifier = options.verifier;
    this.#exporter = options.exporter;
    this.#policy = options.policy;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Returns one filtered page.
   *
   * @param actorId - Authenticated principal.
   * @param filters - Parsed query filters.
   * @param context - Request metadata.
   */
  public async query(
    actorId: string,
    filters: AuditQuery,
    context: AuditRequestContext,
  ): Promise<AuditEventList> {
    try {
      const { visibility } = await this.#visibility(actorId, filters, context);
      const page = await this.#query.page(filters, visibility);
      return {
        events: page.events.map(toPublicEvent),
        nextCursor: page.nextCursor,
      };
    } catch (error) {
      throw wrap(error);
    }
  }

  /**
   * Verifies the retained chain and records the verification.
   *
   * The route always writes its own `audit.read` decision before the walk, so
   * an HTTP caller observes `empty_chain` only when the decision itself could
   * not create a row. The internal verifier still returns it directly.
   *
   * @param actorId - Authenticated principal with organization-scoped read.
   * @param context - Request metadata.
   */
  public async verify(actorId: string, context: AuditRequestContext): Promise<AuditVerifyResponse> {
    try {
      const decision = await this.#policy.authorize(
        actorId,
        "audit.read",
        { type: "org", id: "org" },
        context,
      );
      if (!decision.allowed) {
        throw new AuditAccessDeniedError();
      }
      await this.#writer.ensureCheckpoint();
      const result = await this.#verifier.verify();
      await this.#writer.record({
        eventId: newUlid(),
        ts: new Date(this.#now()),
        projectId: null,
        requestId: context.requestId ?? "internal",
        actorId: decision.actorId,
        actorKind: decision.actorKind,
        action: "audit.verify",
        scopeType: "org",
        scopeId: "org",
        objectType: null,
        objectId: null,
        result: result.ok ? "allow" : "error",
        sourceIp: context.sourceIp ?? null,
        userAgent: context.userAgent ?? null,
        details: {
          ok: result.ok,
          checkedFromEventId: result.checkedRange?.fromEventId ?? null,
          checkedToEventId: result.checkedRange?.toEventId ?? null,
          firstBrokenEventId: result.firstBrokenEventId,
          reason: result.reason,
        },
      });
      return {
        ok: result.ok,
        checkedRange: result.checkedRange,
        firstBrokenEventId: result.firstBrokenEventId,
        reason: result.reason,
      };
    } catch (error) {
      throw wrap(error);
    }
  }

  /**
   * Authorizes an export, records the attempt, and streams NDJSON.
   *
   * The attempt event is written before `start`; a failure after `start`
   * destroys the caller's response and leaves the attempt as evidence.
   *
   * @param actorId - Authenticated principal.
   * @param filters - Parsed export filters.
   * @param context - Request metadata.
   * @param start - Sends the success status and headers.
   * @param write - Writes one NDJSON line.
   */
  public async export(
    actorId: string,
    filters: AuditExportQuery,
    context: AuditRequestContext,
    start: () => void,
    write: (line: string) => Promise<void>,
  ): Promise<void> {
    try {
      const { visibility, decision } = await this.#visibility(actorId, filters, context);
      await this.#writer.ensureCheckpoint();
      const scope = exportScope(filters, visibility);
      let projectId = scope.projectId;
      let scopeType = scope.scopeType;
      let scopeId = scope.scopeId;
      if (projectId !== null && !(await this.#query.projectExists(projectId))) {
        // The project foreign key cannot reference an unknown project. Record
        // the attempt at system scope so an org caller still gets evidence and
        // an empty export instead of an outage.
        projectId = null;
        scopeType = "system";
        scopeId = null;
      }
      await this.#writer.record({
        eventId: newUlid(),
        ts: new Date(this.#now()),
        projectId,
        requestId: context.requestId ?? "internal",
        actorId: decision.actorId,
        actorKind: decision.actorKind,
        action: "audit.export",
        scopeType,
        scopeId,
        objectType: null,
        objectId: null,
        result: "allow",
        sourceIp: context.sourceIp ?? null,
        userAgent: context.userAgent ?? null,
        details: {
          format: "ndjson",
          filters: normalizeAuditFilters(filters),
        },
      });
      start();
      await this.#exporter.export({ filters, visibility, write });
    } catch (error) {
      throw wrap(error);
    }
  }

  /**
   * Records one business event.
   *
   * @param draft - Event fields without identity or timestamp.
   * @param tx - Optional caller transaction for atomic state changes.
   * @returns The persisted event.
   */
  public async record(draft: AuditEventDraft, tx?: AuditQueryExecutor): Promise<AuditEventRecord> {
    return this.#writer.record({ ...draft, eventId: newUlid(), ts: new Date(this.#now()) }, tx);
  }

  /** Resolves the effective visibility and records exactly one decision. */
  async #visibility(
    actorId: string,
    filters: Pick<AuditQuery, "projectId">,
    context: AuditRequestContext,
  ): Promise<{ readonly visibility: AuditVisibility; readonly decision: PolicyDecision }> {
    if (filters.projectId !== undefined) {
      const decision = await this.#policy.authorize(
        actorId,
        "audit.read",
        { type: "project", id: filters.projectId },
        context,
      );
      if (!decision.allowed) {
        throw new AuditAccessDeniedError();
      }
      return { visibility: { kind: "all" }, decision };
    }
    const result = await this.#policy.authorizeList(
      actorId,
      "audit.read",
      { type: "org", id: "org" },
      context,
    );
    if (!result.decision.allowed) {
      throw new AuditAccessDeniedError();
    }
    return { visibility: result.visibility, decision: result.decision };
  }
}

/** Scope and project for one export attempt event. */
function exportScope(
  filters: AuditExportQuery,
  visibility: AuditVisibility,
): {
  readonly scopeType: "org" | "project" | "system";
  readonly scopeId: string | null;
  readonly projectId: string | null;
} {
  if (filters.projectId !== undefined) {
    return {
      scopeType: "project",
      scopeId: filters.projectId,
      projectId: filters.projectId,
    };
  }
  if (visibility.kind === "all") {
    return { scopeType: "org", scopeId: "org", projectId: null };
  }
  if (visibility.projectIds.length === 1) {
    const projectId = visibility.projectIds[0];
    if (projectId !== undefined) {
      return { scopeType: "project", scopeId: projectId, projectId };
    }
  }
  return { scopeType: "system", scopeId: null, projectId: null };
}
