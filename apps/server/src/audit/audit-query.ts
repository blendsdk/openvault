import type { AuditExportQuery, AuditQuery } from "@openvault/api-contract";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { KeyringProvider } from "../security/keyring.js";
import { loadAuditKey, withAuditKey } from "./audit-key-store.js";
import { decodeCursor, filterHash, signCursor, verifyCursor } from "./cursor.js";
import { AuditKeyUnavailableError } from "./errors.js";
import type { AuditEventRecord, AuditVisibility } from "./types.js";

const DEFAULT_BATCH = 500;

/** One `audit_events` row with the source address already canonicalized. */
export interface AuditEventRow {
  readonly id: string;
  readonly event_id: string;
  readonly ts: Date;
  readonly project_id: string | null;
  readonly request_id: string;
  readonly actor_id: string | null;
  readonly actor_kind: "user" | "service" | "system";
  readonly action: AuditEventRecord["action"];
  readonly scope_type: AuditEventRecord["scopeType"];
  readonly scope_id: string | null;
  readonly object_type: string | null;
  readonly object_id: string | null;
  readonly result: AuditEventRecord["result"];
  readonly source_ip: string | null;
  readonly user_agent: string | null;
  readonly details: Readonly<Record<string, AuditEventRecord["details"][string]>>;
  readonly prev_hash: Buffer;
  readonly hash: Buffer;
  readonly hmac: Buffer;
  readonly audit_key_id: string;
}

/** One query page. */
export interface AuditPage {
  /** Events in descending sequence order. */
  readonly events: readonly AuditEventRecord[];
  /** Opaque cursor for the next page, or null. */
  readonly nextCursor: string | null;
}

/** Converts one database row into the internal event record. */
export function mapAuditEventRow(row: AuditEventRow): AuditEventRecord {
  return {
    eventId: row.event_id,
    ts: new Date(row.ts),
    projectId: row.project_id,
    requestId: row.request_id,
    actorId: row.actor_id,
    actorKind: row.actor_kind,
    action: row.action,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    objectType: row.object_type,
    objectId: row.object_id,
    result: row.result,
    sourceIp: row.source_ip,
    userAgent: row.user_agent,
    details: row.details,
    sequenceId: String(row.id),
    prevHash: row.prev_hash,
    hash: row.hash,
    hmac: row.hmac,
    auditKeyId: row.audit_key_id,
  };
}

/** Builds the fixed filter clauses and named parameters. */
function buildClauses(
  filters: Partial<AuditExportQuery>,
  visibility: AuditVisibility,
  extra: { readonly cursorId?: string; readonly afterId?: string; readonly throughId?: string },
): { readonly sql: string; readonly params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.from !== undefined) {
    clauses.push("ts >= :from");
    params.from = filters.from;
  }
  if (filters.to !== undefined) {
    clauses.push("ts <= :to");
    params.to = filters.to;
  }
  if (filters.actorId !== undefined) {
    clauses.push("actor_id = :actorId");
    params.actorId = filters.actorId;
  }
  if (filters.action !== undefined) {
    clauses.push("action = :action");
    params.action = filters.action;
  }
  if (filters.objectType !== undefined) {
    clauses.push("object_type = :objectType");
    params.objectType = filters.objectType;
  }
  if (filters.objectId !== undefined) {
    clauses.push("object_id = :objectId");
    params.objectId = filters.objectId;
  }
  if (filters.result !== undefined) {
    clauses.push("result = :result");
    params.result = filters.result;
  }
  if (filters.requestId !== undefined) {
    clauses.push("request_id = :requestId");
    params.requestId = filters.requestId;
  }
  if (filters.projectId !== undefined) {
    clauses.push("project_id = :projectId");
    params.projectId = filters.projectId;
  }
  if (visibility.kind === "projects") {
    clauses.push("project_id = ANY(:projectIds)");
    params.projectIds = [...visibility.projectIds];
  }
  if (extra.cursorId !== undefined) {
    clauses.push("id < CAST(:cursorId AS bigint)");
    params.cursorId = extra.cursorId;
  }
  if (extra.afterId !== undefined) {
    clauses.push("id > CAST(:afterId AS bigint)");
    params.afterId = extra.afterId;
  }
  if (extra.throughId !== undefined) {
    clauses.push("id <= CAST(:throughId AS bigint)");
    params.throughId = extra.throughId;
  }
  return { sql: clauses.length === 0 ? "TRUE" : clauses.join(" AND "), params };
}

const SELECT_COLUMNS = `id, event_id, ts, project_id, request_id, actor_id, actor_kind, action,
       scope_type, scope_id, object_type, object_id, result, host(source_ip) AS source_ip,
       user_agent, details, prev_hash, hash, hmac, audit_key_id`;

/**
 * Reads filtered audit events and streams them for export or prune.
 *
 * Every SQL fragment is fixed and every caller value is a named parameter.
 */
export class AuditEventQuery {
  readonly #database: PostgreSQLDatabase;
  readonly #keyring: KeyringProvider;

  /**
   * @param options - Connected database and loaded keyring.
   */
  public constructor(options: {
    readonly database: PostgreSQLDatabase;
    readonly keyring: KeyringProvider;
  }) {
    this.#database = options.database;
    this.#keyring = options.keyring;
  }

  /**
   * Returns one descending page and an optional signed continuation cursor.
   *
   * @param filters - Parsed query filters.
   * @param visibility - Effective project visibility.
   * @returns The page and cursor.
   * @throws {AuditQueryError} When the cursor is malformed, forged, or bound to
   *   different filters.
   * @throws {AuditKeyUnavailableError} When a cursor key cannot be unwrapped.
   */
  public async page(filters: AuditQuery, visibility: AuditVisibility): Promise<AuditPage> {
    let cursorId: string | undefined;
    const cursor = filters.cursor;
    if (cursor !== undefined) {
      const payload = decodeCursor(cursor);
      const keyRow = await loadAuditKey(this.#database, payload.kid);
      if (keyRow === undefined) {
        throw new AuditKeyUnavailableError();
      }
      cursorId = withAuditKey(
        this.#keyring,
        keyRow,
        (key) => verifyCursor(cursor, key, filterHash(filters, visibility)).id,
      );
    }

    const { sql, params } = buildClauses(filters, visibility, {
      ...(cursorId === undefined ? {} : { cursorId }),
    });
    const result = await this.#database.executeQuery<AuditEventRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM audit_events
        WHERE ${sql}
        ORDER BY id DESC
        LIMIT :limit`,
      { ...params, limit: filters.limit },
    );
    const events = result.records.map(mapAuditEventRow);

    let nextCursor: string | null = null;
    if (events.length === filters.limit && events.length > 0) {
      const last = events[events.length - 1];
      if (last !== undefined) {
        const keyRow = await loadAuditKey(this.#database, last.auditKeyId);
        if (keyRow === undefined) {
          throw new AuditKeyUnavailableError();
        }
        nextCursor = withAuditKey(this.#keyring, keyRow, (key) =>
          signCursor(
            {
              v: 1,
              kid: last.auditKeyId,
              id: last.sequenceId,
              f: filterHash(filters, visibility),
            },
            key,
          ),
        );
      }
    }
    return { events, nextCursor };
  }

  /**
   * Streams matching events in ascending order.
   *
   * @param filters - Export filters.
   * @param visibility - Effective project visibility.
   * @param batchSize - Rows fetched per batch.
   */
  public async *stream(
    filters: AuditExportQuery,
    visibility: AuditVisibility,
    batchSize = DEFAULT_BATCH,
  ): AsyncGenerator<readonly AuditEventRecord[]> {
    let afterId: string | undefined;
    while (true) {
      const { sql, params } = buildClauses(filters, visibility, {
        ...(afterId === undefined ? {} : { afterId }),
      });
      const result = await this.#database.executeQuery<AuditEventRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM audit_events
          WHERE ${sql}
          ORDER BY id ASC
          LIMIT :limit`,
        { ...params, limit: batchSize },
      );
      const rows = result.records.map(mapAuditEventRow);
      if (rows.length === 0) {
        return;
      }
      yield rows;
      const last = rows[rows.length - 1];
      if (last === undefined) {
        return;
      }
      afterId = last.sequenceId;
      if (rows.length < batchSize) {
        return;
      }
    }
  }

  /**
   * Streams the chain prefix through one sequence id in ascending order.
   *
   * @param lastEventId - Last sequence id to include.
   * @param batchSize - Rows fetched per batch.
   */
  public async *streamThrough(
    lastEventId: string,
    batchSize = DEFAULT_BATCH,
  ): AsyncGenerator<readonly AuditEventRecord[]> {
    let afterId: string | undefined;
    while (true) {
      const { sql, params } = buildClauses(
        {},
        { kind: "all" },
        {
          throughId: lastEventId,
          ...(afterId === undefined ? {} : { afterId }),
        },
      );
      const result = await this.#database.executeQuery<AuditEventRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM audit_events
          WHERE ${sql}
          ORDER BY id ASC
          LIMIT :limit`,
        { ...params, limit: batchSize },
      );
      const rows = result.records.map(mapAuditEventRow);
      if (rows.length === 0) {
        return;
      }
      yield rows;
      const last = rows[rows.length - 1];
      if (last === undefined) {
        return;
      }
      afterId = last.sequenceId;
      if (rows.length < batchSize) {
        return;
      }
    }
  }

  /**
   * Reads one event by sequence id.
   *
   * @param sequenceId - Decimal sequence id.
   * @returns The event, or undefined.
   */
  public async findEvent(sequenceId: string): Promise<AuditEventRecord | undefined> {
    const result = await this.#database.executeQuery<AuditEventRow>(
      `SELECT ${SELECT_COLUMNS} FROM audit_events WHERE id = CAST(:id AS bigint)`,
      { id: sequenceId },
    );
    const row = result.records[0];
    return row === undefined ? undefined : mapAuditEventRow(row);
  }

  /**
   * Returns true when a project row exists.
   *
   * @param projectId - Project identifier.
   * @returns True for an existing row, including a soft-deleted project.
   */
  public async projectExists(projectId: string): Promise<boolean> {
    const result = await this.#database.executeQuery<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM projects WHERE id = :projectId) AS present",
      { projectId },
    );
    return result.records[0]?.present === true;
  }
}
