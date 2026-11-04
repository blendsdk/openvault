import type { AgentConsumer } from "@openvault/api-contract";
import { newUlid } from "@openvault/core";
import type { QueryExecutor } from "../identity/identity-repository.js";

/** Server-derived ownership plus self-reported consumer metadata. */
export interface ConsumerUpsertInput {
  /** Service principal from the token or authenticated certificate. */
  readonly principalId: string;
  /** Owner project from the token or authenticated certificate. */
  readonly projectId: string;
  /** Metadata reported by the agent. */
  readonly consumer: AgentConsumer;
}

/** A persisted consumer row. */
export interface ConsumerRecord {
  /** Consumer identifier. */
  readonly id: string;
  /** Service principal. */
  readonly principalId: string;
  /** Owner project. */
  readonly projectId: string;
  /** Compose project name. */
  readonly composeProject: string;
  /** Compose service name. */
  readonly composeService: string;
  /** Reported hostname. */
  readonly hostname: string;
  /** Manifest hash. */
  readonly manifestHash: string;
  /** Consumer state. */
  readonly state: "ok" | "degraded" | "failed";
  /** First observation. */
  readonly firstSeen: Date;
  /** Last observation. */
  readonly lastSeen: Date;
}

interface ConsumerRow {
  readonly id: string;
  readonly principal_id: string;
  readonly project_id: string;
  readonly compose_project: string;
  readonly compose_service: string;
  readonly hostname: string;
  readonly manifest_hash: string;
  readonly state: string;
  readonly first_seen: Date;
  readonly last_seen: Date;
}

function toRecord(row: ConsumerRow): ConsumerRecord {
  return {
    id: row.id,
    principalId: row.principal_id,
    projectId: row.project_id,
    composeProject: row.compose_project,
    composeService: row.compose_service,
    hostname: row.hostname,
    manifestHash: row.manifest_hash,
    state: row.state === "degraded" ? "degraded" : row.state === "failed" ? "failed" : "ok",
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}

/**
 * Upserts the one consumer row owned by a service identity.
 *
 * Ownership columns come from the server-side binding, never from the request.
 * The first observation time is preserved while metadata and `last_seen` move.
 */
export class ConsumerRepository {
  readonly #database: QueryExecutor;

  /**
   * @param database - Database or transaction executor.
   */
  public constructor(database: QueryExecutor) {
    this.#database = database;
  }

  /**
   * Reads the current consumer row under a row lock.
   *
   * @param principalId - Service principal.
   * @param tx - Join or renewal transaction; defaults to the repository database.
   * @returns The persisted row, or undefined.
   */
  public async findForUpdate(
    principalId: string,
    tx: QueryExecutor = this.#database,
  ): Promise<ConsumerRecord | undefined> {
    const result = await tx.executeQuery<ConsumerRow>(
      `SELECT id, principal_id, project_id, compose_project, compose_service, hostname,
              manifest_hash, state, first_seen, last_seen
         FROM consumers
        WHERE principal_id = :principalId
        FOR UPDATE`,
      { principalId },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Writes self-reported metadata and marks the consumer healthy.
   *
   * @param tx - Join or renewal transaction.
   * @param input - Server-derived ownership and reported metadata.
   * @returns The persisted row.
   */
  public async upsert(tx: QueryExecutor, input: ConsumerUpsertInput): Promise<ConsumerRecord> {
    const result = await tx.executeQuery<ConsumerRow>(
      `INSERT INTO consumers
         (id, principal_id, project_id, compose_project, compose_service, hostname,
          manifest_hash, state, first_seen, last_seen)
       VALUES
         (:id, :principalId, :projectId, :composeProject, :composeService, :hostname,
          :manifestHash, 'ok', now(), now())
       ON CONFLICT (principal_id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         compose_project = EXCLUDED.compose_project,
         compose_service = EXCLUDED.compose_service,
         hostname = EXCLUDED.hostname,
         manifest_hash = EXCLUDED.manifest_hash,
         state = 'ok',
         last_seen = now()
       RETURNING id, principal_id, project_id, compose_project, compose_service, hostname,
                 manifest_hash, state, first_seen, last_seen`,
      {
        id: newUlid(),
        principalId: input.principalId,
        projectId: input.projectId,
        composeProject: input.consumer.composeProject,
        composeService: input.consumer.composeService,
        hostname: input.consumer.hostname,
        manifestHash: input.consumer.manifestHash,
      },
    );
    const row = result.records[0];
    if (row === undefined) {
      throw new Error("consumer upsert did not return a row");
    }
    return toRecord(row);
  }
}

/** One audit-relevant consumer change. */
export type ConsumerChange =
  | { readonly kind: "register" }
  | { readonly kind: "update"; readonly changed: readonly string[] };

/**
 * Compares persisted metadata with the row produced by an upsert.
 *
 * `last_seen` is intentionally ignored: a heartbeat that only refreshes it is
 * not an audited metadata change. The returned field names are stable and
 * ordered.
 *
 * @param previous - Row read before the upsert, or undefined.
 * @param next - Row returned by the upsert.
 * @returns The change, or null when only `last_seen` moved.
 */
export function classifyConsumerChange(
  previous: ConsumerRecord | undefined,
  next: ConsumerRecord,
): ConsumerChange | null {
  if (previous === undefined) {
    return { kind: "register" };
  }
  const changed: string[] = [];
  if (previous.composeProject !== next.composeProject) {
    changed.push("composeProject");
  }
  if (previous.composeService !== next.composeService) {
    changed.push("composeService");
  }
  if (previous.hostname !== next.hostname) {
    changed.push("hostname");
  }
  if (previous.manifestHash !== next.manifestHash) {
    changed.push("manifestHash");
  }
  if (previous.state !== next.state) {
    changed.push("state");
  }
  return changed.length === 0 ? null : { kind: "update", changed };
}
