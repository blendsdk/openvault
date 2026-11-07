import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  closeSync,
  createWriteStream,
  existsSync,
  fsyncSync,
  openSync,
  rmSync,
  type WriteStream,
} from "node:fs";
import { isAbsolute } from "node:path";
import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import { toPublicEvent } from "./audit-export.js";
import type { AuditEventQuery } from "./audit-query.js";
import type { AuditVerifier } from "./audit-verify.js";
import type { AuditWriter } from "./audit-writer.js";
import { AuditError, AuditPruneConfigError } from "./errors.js";
import type { PruneAuthorizationInput } from "./prune-authorization.js";

const DAY_MS = 86_400_000;

/** Result of one prune run. */
export interface AuditPruneResult {
  /** Retention cutoff used for the run. */
  readonly cutoff: Date;
  /** Number of rows written to the export file. */
  readonly exportedCount: number;
  /** Number of rows deleted. */
  readonly deletedCount: number;
  /** Boundary checkpoint id, or null when there was nothing to prune. */
  readonly checkpointId: string | null;
  /** Single-use authorization id, or null for a dry run or empty prefix. */
  readonly authorizationId: string | null;
  /** SHA-256 of the exported NDJSON bytes, or null when nothing was exported. */
  readonly exportSha256: string | null;
  /** True when the command did not delete rows. */
  readonly dryRun: boolean;
}

/** Options for {@link AuditPruner}. */
export interface AuditPruneOptions {
  /** Application database used for reads, checkpoint, and the prune event. */
  readonly database: PostgreSQLDatabase;
  /** Chain writer. */
  readonly writer: AuditWriter;
  /** Filtered query and prefix stream. */
  readonly query: AuditEventQuery;
  /** Verifies the retained chain before any export or delete. */
  readonly verifier: AuditVerifier;
  /** Database name verified and exported by the application connection. */
  readonly databaseName: string;
  /** Creates one short-lived authorization after verification and export. */
  readonly authorizePrune: (input: PruneAuthorizationInput) => Promise<string>;
  /** Executes the pruner-session procedure for one authorization. */
  readonly deletePrefix: (authorizationId: string) => Promise<number>;
  /** Injectable clock. */
  readonly now?: () => number;
  /** Validated retention window. */
  readonly retentionDays: number;
}

/**
 * Exports and deletes the audit prefix older than the retention window.
 *
 * The retained chain is verified before anything is written. The prefix is
 * exported to an exclusive file, a checkpoint is written at its last event,
 * and only then is the pruner connection allowed to delete it.
 */
export class AuditPruner {
  readonly #database: PostgreSQLDatabase;
  readonly #writer: AuditWriter;
  readonly #query: AuditEventQuery;
  readonly #verifier: AuditVerifier;
  readonly #deletePrefix: (authorizationId: string) => Promise<number>;
  readonly #databaseName: string;
  readonly #authorizePrune: (input: PruneAuthorizationInput) => Promise<string>;
  readonly #now: () => number;
  readonly #retentionDays: number;

  /**
   * @param options - Persistence, verification, prune connection, and clock.
   */
  public constructor(options: AuditPruneOptions) {
    this.#database = options.database;
    this.#writer = options.writer;
    this.#query = options.query;
    this.#verifier = options.verifier;
    this.#authorizePrune = options.authorizePrune;
    this.#deletePrefix = options.deletePrefix;
    this.#databaseName = options.databaseName;
    this.#now = options.now ?? Date.now;
    this.#retentionDays = options.retentionDays;
  }

  /**
   * Runs one prune.
   *
   * @param options - Absolute output path and dry-run flag.
   * @returns The run summary.
   */
  public async prune(options: {
    readonly outputPath: string;
    readonly dryRun?: boolean;
  }): Promise<AuditPruneResult> {
    if (!isAbsolute(options.outputPath)) {
      throw new AuditPruneConfigError("Output path must be absolute");
    }
    if (existsSync(options.outputPath)) {
      throw new AuditPruneConfigError("Output path already exists");
    }
    const cutoff = new Date(this.#now() - this.#retentionDays * DAY_MS);
    const verification = await this.#verifier.verify();
    if (!verification.ok) {
      throw new AuditError(`Retained chain verification failed: ${verification.reason}`);
    }

    const boundary = await this.#database.executeQuery<{ id: string | null }>(
      "SELECT max(id) AS id FROM audit_events WHERE ts < :cutoff",
      { cutoff },
    );
    const lastEventId = boundary.records[0]?.id ?? null;
    if (lastEventId === null) {
      const result: AuditPruneResult = {
        cutoff,
        exportedCount: 0,
        deletedCount: 0,
        checkpointId: null,
        authorizationId: null,
        exportSha256: null,
        dryRun: options.dryRun === true,
      };
      await this.#recordPrune(result);
      return result;
    }

    const exported = await this.#exportPrefix(options.outputPath, lastEventId);
    let boundaryEvent: Awaited<ReturnType<AuditEventQuery["findEvent"]>>;
    try {
      boundaryEvent = await this.#query.findEvent(lastEventId);
    } catch (error) {
      rmSync(options.outputPath, { force: true });
      throw error;
    }
    if (boundaryEvent === undefined) {
      rmSync(options.outputPath, { force: true });
      throw new AuditError("Prune boundary event disappeared");
    }

    let checkpointId: string;
    try {
      checkpointId = (await this.#writer.checkpointAt(boundaryEvent)).id;
    } catch (error) {
      rmSync(options.outputPath, { force: true });
      throw error;
    }

    const dryRun = options.dryRun === true;
    let deletedCount = 0;
    let authorizationId: string | null = null;
    if (!dryRun) {
      authorizationId = await this.#authorizePrune({
        database: this.#databaseName,
        lastEventId,
        lastHash: boundaryEvent.hash,
        count: exported.count,
        exportSha256: exported.sha256,
        cutoff,
      });
      deletedCount = await this.#deletePrefix(authorizationId);
    }

    const result: AuditPruneResult = {
      cutoff,
      exportedCount: exported.count,
      deletedCount,
      checkpointId,
      authorizationId,
      exportSha256: exported.sha256.toString("hex"),
      dryRun,
    };
    await this.#recordPrune(result);
    return result;
  }

  /** Writes the prefix as NDJSON with an exclusive mode-0600 file. */
  async #exportPrefix(
    outputPath: string,
    lastEventId: string,
  ): Promise<{ readonly count: number; readonly sha256: Buffer }> {
    let stream: WriteStream | undefined;
    let created = false;
    let streamError: Error | undefined;
    let count = 0;
    const digest = createHash("sha256");
    try {
      stream = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
      stream.on("error", (error: Error) => {
        streamError = error;
      });
      await once(stream, "open");
      created = true;
      const errorSignal = new Promise<never>((_, reject) => {
        stream?.once("error", reject);
      });
      for await (const batch of this.#query.streamThrough(lastEventId)) {
        for (const event of batch) {
          if (streamError !== undefined) {
            throw streamError;
          }
          const line = `${JSON.stringify(toPublicEvent(event))}\n`;
          digest.update(line, "utf8");
          if (!stream.write(line)) {
            await Promise.race([once(stream, "drain"), errorSignal]);
          }
          count += 1;
        }
      }
      stream.end();
      await Promise.race([once(stream, "finish"), errorSignal]);
      if (streamError !== undefined) {
        throw streamError;
      }
      const descriptor = openSync(outputPath, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      return { count, sha256: digest.digest() };
    } catch (error) {
      stream?.destroy();
      if (created) {
        rmSync(outputPath, { force: true });
      }
      if (error instanceof AuditError) {
        throw error;
      }
      throw new AuditPruneConfigError("Could not write the audit export file");
    }
  }

  /** Records the completion event with the run counts. */
  async #recordPrune(result: AuditPruneResult): Promise<void> {
    await this.#writer.record({
      eventId: newUlid(),
      ts: new Date(this.#now()),
      projectId: null,
      requestId: "audit-prune",
      actorId: null,
      actorKind: "system",
      action: "audit.prune",
      scopeType: "system",
      scopeId: null,
      objectType: null,
      objectId: null,
      result: "allow",
      sourceIp: null,
      userAgent: null,
      details: {
        cutoff: result.cutoff.toISOString(),
        exportedCount: result.exportedCount,
        deletedCount: result.deletedCount,
        checkpointId: result.checkpointId,
        authorizationId: result.authorizationId,
        exportSha256: result.exportSha256,
        dryRun: result.dryRun,
      },
    });
  }
}
