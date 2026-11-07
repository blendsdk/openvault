import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";

/** Input for one short-lived prune authorization. */
export interface PruneAuthorizationInput {
  /** Verified database name. */
  readonly database: string;
  /** Boundary event sequence id. */
  readonly lastEventId: string;
  /** Boundary event hash. */
  readonly lastHash: Buffer;
  /** Number of exported rows. */
  readonly count: number;
  /** SHA-256 of the exported NDJSON bytes. */
  readonly exportSha256: Buffer;
  /** Retention cutoff used for the run. */
  readonly cutoff: Date;
}

/**
 * Records one single-use prune authorization after verification and export.
 *
 * The authorization is created on the application connection. The pruner role
 * cannot insert it, so a stolen pruner credential alone cannot delete an audit
 * prefix. The row expires after ten minutes.
 *
 * @param database - Application database connection.
 * @param input - Verified boundary, count, export hash, and cutoff.
 * @returns The authorization identifier passed to the pruner procedure.
 *
 * @example
 * ```ts
 * const id = await createPruneAuthorization(database, {
 *   database: "openvault",
 *   lastEventId: "42",
 *   lastHash: boundaryHash,
 *   count: 10,
 *   exportSha256: digest,
 *   cutoff: new Date(),
 * });
 * ```
 */
export async function createPruneAuthorization(
  database: PostgreSQLDatabase,
  input: PruneAuthorizationInput,
): Promise<string> {
  const id = newUlid();
  await database.executeQuery(
    `INSERT INTO audit_prune_authorizations
       (id, database_name, last_event_id, last_hash, expected_count,
        export_sha256, cutoff, expires_at)
     VALUES
       (:id, :database, CAST(:lastEventId AS bigint), :lastHash, :count,
        :exportSha256, :cutoff, now() + interval '10 minutes')`,
    {
      id,
      database: input.database,
      lastEventId: input.lastEventId,
      lastHash: input.lastHash,
      count: input.count,
      exportSha256: input.exportSha256,
      cutoff: input.cutoff,
    },
  );
  return id;
}
