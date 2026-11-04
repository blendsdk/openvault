import { isIP } from "node:net";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { KeyringProvider } from "../security/keyring.js";
import { AUDIT_ACTION_SET, validateDetails } from "./actions.js";
import {
  type AuditKeyRow,
  loadAuditKey,
  selectOrCreateAuditKey,
  withAuditKey,
} from "./audit-key-store.js";
import { canonicalJson } from "./canonical-json.js";
import {
  AuditError,
  AuditInputError,
  AuditUnavailableError,
  CanonicalJsonError,
} from "./errors.js";
import {
  canonicalEventForHash,
  computeCheckpointHmac,
  computeEventHash,
  computeEventHmac,
} from "./hashing.js";
import type { AuditEventInput, AuditEventRecord, AuditQueryExecutor } from "./types.js";

/** Fixed transaction-scoped advisory lock reserved for the audit chain. */
export const AUDIT_CHAIN_LOCK_ID = 780_217_001;

const DEFAULT_CHECKPOINT_EVERY = 1_000;
const DEFAULT_CHECKPOINT_AGE_MS = 86_400_000;
const MAX_USER_AGENT = 512;
const MAX_REQUEST_ID = 100;
const MAX_SCOPE_ID = 64;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Shortens a user agent without splitting a surrogate pair. */
function truncateUserAgent(value: string): string {
  if (value.length <= MAX_USER_AGENT) {
    return value;
  }
  let end = MAX_USER_AGENT;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return value.slice(0, end);
}

/** One checkpoint row. */
export interface AuditCheckpointRecord {
  /** Checkpoint row identifier. */
  readonly id: string;
  /** Sequence id of the referenced event. */
  readonly lastEventId: string;
  /** Hash of the referenced event. */
  readonly lastHash: Buffer;
  /** HMAC over the sequence id and hash. */
  readonly hmac: Buffer;
  /** Key used for the HMAC. */
  readonly auditKeyId: string;
  /** Creation time. */
  readonly createdAt: Date;
}

/** Writer tuning; production leaves the defaults. */
export interface AuditWriterOptions {
  /** Connected database. */
  readonly database: PostgreSQLDatabase;
  /**
   * Pool used for decisions that must commit independently of a caller
   * transaction. Defaults to the main database when omitted.
   */
  readonly independentDatabase?: PostgreSQLDatabase;
  /** Loaded KEK provider. */
  readonly keyring: KeyringProvider;
  /** Injectable clock in milliseconds since the Unix epoch. */
  readonly now?: () => number;
  /** Events between count-based checkpoints. */
  readonly checkpointEvery?: number;
  /** Age in milliseconds that triggers a checkpoint. */
  readonly checkpointAgeMs?: number;
}

interface CheckpointRow {
  readonly id: string;
  readonly last_event_id: string;
  readonly last_hash: Buffer;
  readonly hmac: Buffer;
  readonly audit_key_id: string;
  readonly created_at: Date;
}

interface LatestEventRow {
  readonly id: string;
  readonly hash: Buffer;
  readonly audit_key_id: string;
}

interface LatestCheckpointRow {
  readonly last_event_id: string;
  readonly created_at: Date;
}

/** Maps one checkpoint row to the internal shape. */
function toCheckpointRecord(row: CheckpointRow): AuditCheckpointRecord {
  return {
    id: String(row.id),
    lastEventId: String(row.last_event_id),
    lastHash: row.last_hash,
    hmac: row.hmac,
    auditKeyId: row.audit_key_id,
    createdAt: new Date(row.created_at),
  };
}

/** The event identity and chain fields a checkpoint needs. */
interface CheckpointTarget {
  readonly sequenceId: string;
  readonly hash: Buffer;
}

/**
 * Appends events to the audit chain and maintains its checkpoints.
 *
 * Every insert runs under one transaction-scoped advisory lock, reads the
 * previous hash, and computes the chain hash and HMAC before the row becomes
 * visible. The writer never updates or deletes a row.
 *
 * Caller transactions must use the default READ COMMITTED isolation. A
 * snapshot-isolation transaction can read a stale previous hash after taking
 * the lock and silently fork the chain.
 */
export class AuditWriter {
  readonly #database: PostgreSQLDatabase;
  readonly #independentDatabase: PostgreSQLDatabase;
  readonly #keyring: KeyringProvider;
  readonly #now: () => number;
  readonly #checkpointEvery: number;
  readonly #checkpointAgeMs: number;

  /**
   * @param options - Database, keyring, clock, and checkpoint cadence.
   */
  public constructor(options: AuditWriterOptions) {
    this.#database = options.database;
    this.#independentDatabase = options.independentDatabase ?? options.database;
    this.#keyring = options.keyring;
    this.#now = options.now ?? Date.now;
    this.#checkpointEvery = options.checkpointEvery ?? DEFAULT_CHECKPOINT_EVERY;
    this.#checkpointAgeMs = options.checkpointAgeMs ?? DEFAULT_CHECKPOINT_AGE_MS;
    if (this.#checkpointEvery < 1 || this.#checkpointAgeMs < 1) {
      throw new AuditInputError("Checkpoint cadence must be positive");
    }
  }

  /**
   * Appends one event, optionally inside a caller transaction.
   *
   * When a transaction is supplied, the event commits or rolls back with the
   * caller's state change. Otherwise the writer opens its own transaction.
   *
   * @param input - Event with identity and timestamp assigned.
   * @param tx - Caller transaction, when the event must be atomic with a mutation.
   * @param options - Chain-continuation override used after a full prune.
   * @returns The persisted event with its sequence id and chain fields.
   * @throws {AuditInputError} When the event violates the stored contract.
   * @throws {AuditKeyUnavailableError} When the audit key cannot be unwrapped.
   * @throws {AuditUnavailableError} When persistence fails.
   */
  public async record(
    input: AuditEventInput,
    tx?: AuditQueryExecutor,
    options?: { readonly previousHash?: Buffer },
  ): Promise<AuditEventRecord> {
    const validated = this.#validate(input);
    try {
      if (tx !== undefined) {
        return await this.#write(validated, tx, options);
      }
      return await this.#database.withTransaction(async (transaction) =>
        this.#write(validated, transaction, options),
      );
    } catch (error) {
      throw this.#wrap(error);
    }
  }

  /**
   * Appends one event in its own transaction, even when a caller transaction is
   * active on the main database handle.
   *
   * The chain lock still serializes the write. The independent pool exists so a
   * decision can survive the rollback of the state change it authorized.
   *
   * @param input - Event with identity and timestamp assigned.
   * @returns The persisted event with its sequence id and chain fields.
   */
  public async recordIndependent(input: AuditEventInput): Promise<AuditEventRecord> {
    const validated = this.#validate(input);
    try {
      return await this.#independentDatabase.withTransaction(async (transaction) =>
        this.#write(validated, transaction, undefined),
      );
    } catch (error) {
      throw this.#wrap(error);
    }
  }

  /**
   * Writes a checkpoint when the cadence requires one.
   *
   * @param tx - Optional caller transaction.
   * @returns The new checkpoint, or undefined when none is due.
   */
  public async ensureCheckpoint(
    tx?: AuditQueryExecutor,
  ): Promise<AuditCheckpointRecord | undefined> {
    try {
      if (tx !== undefined) {
        return await this.#ensureCheckpoint(tx);
      }
      return await this.#database.withTransaction(async (transaction) =>
        this.#ensureCheckpoint(transaction),
      );
    } catch (error) {
      throw this.#wrap(error);
    }
  }

  /**
   * Writes or returns the checkpoint anchored at one event.
   *
   * @param event - Event that becomes the checkpoint boundary.
   * @param tx - Optional caller transaction.
   * @returns The existing or newly written checkpoint.
   */
  public async checkpointAt(
    event: AuditEventRecord,
    tx?: AuditQueryExecutor,
  ): Promise<AuditCheckpointRecord> {
    try {
      if (tx !== undefined) {
        return await this.#checkpointAt(event, tx);
      }
      return await this.#database.withTransaction(async (transaction) =>
        this.#checkpointAt(event, transaction),
      );
    } catch (error) {
      throw this.#wrap(error);
    }
  }

  /** Validates the public field bounds before any database work. */
  #validate(input: AuditEventInput): AuditEventInput {
    if (!AUDIT_ACTION_SET.has(input.action)) {
      throw new AuditInputError("Unknown audit action");
    }
    if (!ULID_PATTERN.test(input.eventId)) {
      throw new AuditInputError("Event id must be a ULID");
    }
    if (!Number.isFinite(input.ts.getTime())) {
      throw new AuditInputError("Event timestamp is invalid");
    }
    if (input.requestId.length < 1 || input.requestId.length > MAX_REQUEST_ID) {
      throw new AuditInputError("Request id is outside the stored bound");
    }
    if (input.projectId !== null && !ULID_PATTERN.test(input.projectId)) {
      throw new AuditInputError("Project id must be a ULID");
    }
    if (input.actorKind === "system" && input.actorId !== null) {
      throw new AuditInputError("A system event cannot have an actor id");
    }
    if (input.actorId !== null && !ULID_PATTERN.test(input.actorId)) {
      throw new AuditInputError("Actor id must be a ULID");
    }
    for (const value of [input.scopeId, input.objectType, input.objectId]) {
      if (value !== null && (value.length < 1 || value.length > MAX_SCOPE_ID)) {
        throw new AuditInputError("Scope and object values are outside the stored bound");
      }
    }
    if (input.scopeType === "system") {
      if (input.scopeId !== null || input.projectId !== null) {
        throw new AuditInputError("A system scope has no scope or project id");
      }
    } else if (input.scopeType === "org") {
      if (input.projectId !== null) {
        throw new AuditInputError("An organization scope has no project id");
      }
    } else if (input.projectId === null) {
      throw new AuditInputError("Project and object scopes require a project id");
    }
    validateDetails(input.action, input.details);
    return {
      ...input,
      userAgent: input.userAgent === null ? null : truncateUserAgent(input.userAgent),
      details: structuredClone(input.details),
    };
  }

  /** Normalizes one client address through PostgreSQL. */
  async #normalizeSourceIp(
    tx: AuditQueryExecutor,
    sourceIp: string | null,
  ): Promise<string | null> {
    if (sourceIp === null) {
      return null;
    }
    if (isIP(sourceIp) === 0) {
      throw new AuditInputError("Source address is not a valid IP address");
    }
    const result = await tx.executeQuery<{ ip: string }>("SELECT host(CAST(:ip AS inet)) AS ip", {
      ip: sourceIp,
    });
    return result.records[0]?.ip ?? null;
  }

  /** Returns the hash that the next event must link to. */
  async #previousHash(tx: AuditQueryExecutor, override: Buffer | undefined): Promise<Buffer> {
    const latest = await tx.executeQuery<{ id: string; hash: Buffer }>(
      "SELECT id, hash FROM audit_events ORDER BY id DESC LIMIT 1",
    );
    const row = latest.records[0];
    if (row !== undefined) {
      return row.hash;
    }
    if (override !== undefined) {
      return override;
    }
    const checkpoint = await tx.executeQuery<{ last_hash: Buffer }>(
      "SELECT last_hash FROM audit_checkpoints ORDER BY last_event_id DESC LIMIT 1",
    );
    return checkpoint.records[0]?.last_hash ?? Buffer.alloc(32, 0);
  }

  /** Inserts one event while the chain lock is held. */
  async #write(
    input: AuditEventInput,
    tx: AuditQueryExecutor,
    options: { readonly previousHash?: Buffer } | undefined,
  ): Promise<AuditEventRecord> {
    const sourceIp = await this.#normalizeSourceIp(tx, input.sourceIp);
    const normalized: AuditEventInput = { ...input, sourceIp };

    await tx.executeQuery("SELECT pg_advisory_xact_lock(:lockId)", {
      lockId: AUDIT_CHAIN_LOCK_ID,
    });

    const now = new Date(this.#now());
    const keyRow = await selectOrCreateAuditKey(tx, this.#keyring, now);
    const prevHash = await this.#previousHash(tx, options?.previousHash);
    const canonical = canonicalJson(canonicalEventForHash(normalized, prevHash, keyRow.id));
    const hash = computeEventHash(canonical, prevHash);
    const hmac = withAuditKey(this.#keyring, keyRow, (key) => computeEventHmac(key, hash));

    const inserted = await tx.executeQuery<{ id: string }>(
      `INSERT INTO audit_events
         (event_id, ts, project_id, request_id, actor_id, actor_kind, action, scope_type,
          scope_id, object_type, object_id, result, source_ip, user_agent, details,
          prev_hash, hash, hmac, audit_key_id)
       VALUES
         (:eventId, :ts, :projectId, :requestId, :actorId, :actorKind, :action, :scopeType,
          :scopeId, :objectType, :objectId, :result, :sourceIp, :userAgent, :details,
          :prevHash, :hash, :hmac, :auditKeyId)
       RETURNING id`,
      {
        eventId: normalized.eventId,
        ts: normalized.ts,
        projectId: normalized.projectId,
        requestId: normalized.requestId,
        actorId: normalized.actorId,
        actorKind: normalized.actorKind,
        action: normalized.action,
        scopeType: normalized.scopeType,
        scopeId: normalized.scopeId,
        objectType: normalized.objectType,
        objectId: normalized.objectId,
        result: normalized.result,
        sourceIp: normalized.sourceIp,
        userAgent: normalized.userAgent,
        details: normalized.details,
        prevHash,
        hash,
        hmac,
        auditKeyId: keyRow.id,
      },
    );
    const sequenceId = inserted.records[0]?.id;
    if (sequenceId === undefined) {
      throw new AuditUnavailableError("Audit insert returned no sequence id");
    }

    const record: AuditEventRecord = {
      ...normalized,
      sequenceId: String(sequenceId),
      prevHash,
      hash,
      hmac,
      auditKeyId: keyRow.id,
    };
    await this.#maybeCheckpoint(tx, record, keyRow, now);
    return record;
  }

  /** Writes a checkpoint when one of the cadence rules fires. */
  async #maybeCheckpoint(
    tx: AuditQueryExecutor,
    event: AuditEventRecord,
    keyRow: AuditKeyRow,
    now: Date,
  ): Promise<void> {
    const latest = await tx.executeQuery<LatestCheckpointRow>(
      `SELECT last_event_id, created_at
         FROM audit_checkpoints
        ORDER BY last_event_id DESC
        LIMIT 1`,
    );
    const checkpoint = latest.records[0];
    if (checkpoint === undefined) {
      await this.#insertCheckpoint(tx, event, keyRow, now);
      return;
    }
    if (BigInt(event.sequenceId) <= BigInt(checkpoint.last_event_id)) {
      return;
    }

    const count = await tx.executeQuery<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM audit_events
        WHERE id > CAST(:lastEventId AS bigint)`,
      { lastEventId: checkpoint.last_event_id },
    );
    const dueByCount = (count.records[0]?.count ?? 0) >= this.#checkpointEvery;
    const dueByAge =
      now.getTime() - new Date(checkpoint.created_at).getTime() >= this.#checkpointAgeMs;
    if (dueByCount || dueByAge) {
      await this.#insertCheckpoint(tx, event, keyRow, now);
    }
  }

  /** Inserts one idempotent checkpoint row. */
  async #insertCheckpoint(
    tx: AuditQueryExecutor,
    event: CheckpointTarget,
    keyRow: AuditKeyRow,
    createdAt: Date,
  ): Promise<AuditCheckpointRecord> {
    const hmac = withAuditKey(this.#keyring, keyRow, (key) =>
      computeCheckpointHmac(key, event.sequenceId, event.hash),
    );
    await tx.executeQuery(
      `INSERT INTO audit_checkpoints (last_event_id, last_hash, hmac, audit_key_id, created_at)
       VALUES (CAST(:lastEventId AS bigint), :lastHash, :hmac, :auditKeyId, :createdAt)
       ON CONFLICT (last_event_id) DO NOTHING`,
      {
        lastEventId: event.sequenceId,
        lastHash: event.hash,
        hmac,
        auditKeyId: keyRow.id,
        createdAt,
      },
    );
    const row = await tx.executeQuery<CheckpointRow>(
      `SELECT id, last_event_id, last_hash, hmac, audit_key_id, created_at
         FROM audit_checkpoints
        WHERE last_event_id = CAST(:lastEventId AS bigint)`,
      { lastEventId: event.sequenceId },
    );
    const stored = row.records[0];
    if (stored === undefined) {
      throw new AuditUnavailableError("Checkpoint insert returned no row");
    }
    if (!stored.last_hash.equals(event.hash)) {
      throw new AuditUnavailableError("Checkpoint conflicts with the stored hash");
    }
    return toCheckpointRecord(stored);
  }

  /** Implements {@link ensureCheckpoint} inside one transaction. */
  async #ensureCheckpoint(tx: AuditQueryExecutor): Promise<AuditCheckpointRecord | undefined> {
    await tx.executeQuery("SELECT pg_advisory_xact_lock(:lockId)", {
      lockId: AUDIT_CHAIN_LOCK_ID,
    });
    const latestEvent = await tx.executeQuery<LatestEventRow>(
      "SELECT id, hash, audit_key_id FROM audit_events ORDER BY id DESC LIMIT 1",
    );
    const event = latestEvent.records[0];
    if (event === undefined) {
      return undefined;
    }

    const latestCheckpoint = await tx.executeQuery<LatestCheckpointRow>(
      `SELECT last_event_id, created_at
         FROM audit_checkpoints
        ORDER BY last_event_id DESC
        LIMIT 1`,
    );
    const checkpoint = latestCheckpoint.records[0];
    const now = new Date(this.#now());
    let due = checkpoint === undefined;
    if (checkpoint !== undefined && BigInt(event.id) > BigInt(checkpoint.last_event_id)) {
      const count = await tx.executeQuery<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM audit_events
          WHERE id > CAST(:lastEventId AS bigint)`,
        { lastEventId: checkpoint.last_event_id },
      );
      due =
        due ||
        (count.records[0]?.count ?? 0) >= this.#checkpointEvery ||
        now.getTime() - new Date(checkpoint.created_at).getTime() >= this.#checkpointAgeMs;
    }
    if (!due) {
      return undefined;
    }

    const keyRow = await this.#loadKeyRow(tx, event.audit_key_id);
    return this.#insertCheckpoint(
      tx,
      { sequenceId: String(event.id), hash: event.hash },
      keyRow,
      now,
    );
  }

  /** Implements {@link checkpointAt} inside one transaction. */
  async #checkpointAt(
    event: AuditEventRecord,
    tx: AuditQueryExecutor,
  ): Promise<AuditCheckpointRecord> {
    await tx.executeQuery("SELECT pg_advisory_xact_lock(:lockId)", {
      lockId: AUDIT_CHAIN_LOCK_ID,
    });
    const stored = await tx.executeQuery<{ hash: Buffer; audit_key_id: string }>(
      "SELECT hash, audit_key_id FROM audit_events WHERE id = CAST(:id AS bigint)",
      { id: event.sequenceId },
    );
    const row = stored.records[0];
    if (
      row === undefined ||
      !row.hash.equals(event.hash) ||
      row.audit_key_id !== event.auditKeyId
    ) {
      throw new AuditUnavailableError("Checkpoint event does not match the stored row");
    }
    const keyRow = await this.#loadKeyRow(tx, event.auditKeyId);
    return this.#insertCheckpoint(tx, event, keyRow, new Date(this.#now()));
  }

  /** Loads one key row or fails closed. */
  async #loadKeyRow(tx: AuditQueryExecutor, id: string): Promise<AuditKeyRow> {
    const row = await loadAuditKey(tx, id);
    if (row === undefined) {
      throw new AuditUnavailableError("Audit key row is missing");
    }
    return row;
  }

  /** Wraps unexpected driver failures without hiding audit input errors. */
  #wrap(error: unknown): Error {
    if (error instanceof AuditError || error instanceof CanonicalJsonError) {
      return error;
    }
    return new AuditUnavailableError("Audit write failed", error);
  }
}
