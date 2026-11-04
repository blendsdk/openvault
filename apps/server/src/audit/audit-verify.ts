import { timingSafeEqual } from "node:crypto";
import type { AuditVerifyReason } from "@openvault/api-contract";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { KeyringProvider } from "../security/keyring.js";
import { loadAuditKey, unwrapAuditKey } from "./audit-key-store.js";
import { type AuditEventRow, mapAuditEventRow } from "./audit-query.js";
import { canonicalJson } from "./canonical-json.js";
import { AuditKeyUnavailableError } from "./errors.js";
import {
  canonicalEventForHash,
  computeCheckpointHmac,
  computeEventHash,
  computeEventHmac,
} from "./hashing.js";

const ZERO_HASH = Buffer.alloc(32, 0);
const BATCH_SIZE = 1_000;
const SELECT_COLUMNS = `id, event_id, ts, project_id, request_id, actor_id, actor_kind, action,
       scope_type, scope_id, object_type, object_id, result, host(source_ip) AS source_ip,
       user_agent, details, prev_hash, hash, hmac, audit_key_id`;

interface FirstEventRow {
  readonly id: string;
  readonly event_id: string;
  readonly prev_hash: Buffer;
}

interface CheckpointRow {
  readonly id: string;
  readonly last_event_id: string;
  readonly last_hash: Buffer;
  readonly hmac: Buffer;
  readonly audit_key_id: string;
}

/** One chain verification result. */
export interface AuditVerifyResult {
  /** True only when every retained link and checkpoint is valid. */
  readonly ok: boolean;
  /** First and last event ULIDs actually walked, or null. */
  readonly checkedRange: {
    readonly fromEventId: string | null;
    readonly toEventId: string | null;
  } | null;
  /** Event whose link, hash, or HMAC failed, or null for a checkpoint failure. */
  readonly firstBrokenEventId: string | null;
  /** Stable reason code. */
  readonly reason: AuditVerifyReason;
}

/** Builds a failed result. */
function failed(
  reason: AuditVerifyReason,
  firstBrokenEventId: string | null,
  checkedRange: AuditVerifyResult["checkedRange"],
): AuditVerifyResult {
  return { ok: false, checkedRange, firstBrokenEventId, reason };
}

/**
 * Verifies the retained chain and its checkpoints.
 *
 * The walk always includes the first retained event. When a checkpoint exists
 * at that event, its canonical hash is recomputed and compared to the
 * checkpoint's trusted hash; when a boundary checkpoint exists below the
 * retained window, its hash must equal the first retained event's previous
 * hash. Every checkpoint at or after the retained window is checked, so a
 * newer checkpoint cannot mask an older deletion.
 */
export class AuditVerifier {
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

  /** Verifies the retained chain. */
  public async verify(): Promise<AuditVerifyResult> {
    const keys = new Map<string, Buffer>();
    try {
      return await this.#verify(keys);
    } finally {
      for (const key of keys.values()) {
        key.fill(0);
      }
    }
  }

  /** Loads and caches one unwrapped audit key. */
  async #key(id: string, keys: Map<string, Buffer>): Promise<Buffer> {
    const cached = keys.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const row = await loadAuditKey(this.#database, id);
    if (row === undefined) {
      throw new AuditKeyUnavailableError();
    }
    const key = unwrapAuditKey(this.#keyring, row);
    keys.set(id, key);
    return key;
  }

  /** Runs the verification with a caller-owned key cache. */
  async #verify(keys: Map<string, Buffer>): Promise<AuditVerifyResult> {
    const firstResult = await this.#database.executeQuery<FirstEventRow>(
      "SELECT id, event_id, prev_hash FROM audit_events ORDER BY id ASC LIMIT 1",
    );
    const first = firstResult.records[0];
    if (first === undefined) {
      const checkpoints = await this.#database.executeQuery<{ present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM audit_checkpoints) AS present",
      );
      return checkpoints.records[0]?.present === true
        ? failed("tail_truncated", null, null)
        : { ok: true, checkedRange: null, firstBrokenEventId: null, reason: "empty_chain" };
    }

    const firstId = String(first.id);
    const firstEventId = first.event_id;
    let expectedPrevious = first.prev_hash;

    const boundaryResult = await this.#database.executeQuery<CheckpointRow>(
      `SELECT id, last_event_id, last_hash, hmac, audit_key_id
         FROM audit_checkpoints
        WHERE last_event_id < CAST(:firstId AS bigint)
        ORDER BY last_event_id DESC
        LIMIT 1`,
      { firstId },
    );
    const boundary = boundaryResult.records[0];
    const atFirstResult = await this.#database.executeQuery<CheckpointRow>(
      `SELECT id, last_event_id, last_hash, hmac, audit_key_id
         FROM audit_checkpoints
        WHERE last_event_id = CAST(:firstId AS bigint)`,
      { firstId },
    );
    const atFirst = atFirstResult.records[0];

    if (boundary !== undefined) {
      const checked = await this.#checkCheckpoint(boundary, keys, firstId, firstEventId, null);
      if (checked !== undefined) {
        return checked;
      }
      if (!boundary.last_hash.equals(first.prev_hash)) {
        return failed("prev_hash_mismatch", firstEventId, null);
      }
      expectedPrevious = boundary.last_hash;
    } else if (atFirst !== undefined) {
      const checked = await this.#checkCheckpoint(atFirst, keys, firstId, firstEventId, null);
      if (checked !== undefined) {
        return checked;
      }
    } else if (!first.prev_hash.equals(ZERO_HASH)) {
      return failed("missing_checkpoint", firstEventId, null);
    }

    let afterId: string | undefined;
    let checkedFrom: string | null = null;
    let checkedTo: string | null = null;
    let firstWalked = true;
    while (true) {
      const params: Record<string, unknown> = {};
      let where: string;
      if (afterId === undefined) {
        where = "id >= CAST(:firstId AS bigint)";
        params.firstId = firstId;
      } else {
        where = "id > CAST(:afterId AS bigint)";
        params.afterId = afterId;
      }
      const rows = await this.#database.executeQuery<AuditEventRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM audit_events
          WHERE ${where}
          ORDER BY id ASC
          LIMIT ${BATCH_SIZE}`,
        params,
      );
      if (rows.records.length === 0) {
        break;
      }
      for (const row of rows.records) {
        const record = mapAuditEventRow(row);
        if (!record.prevHash.equals(expectedPrevious)) {
          return failed("prev_hash_mismatch", record.eventId, range(checkedFrom, checkedTo));
        }
        let hash: Buffer;
        try {
          const canonical = canonicalJson(
            canonicalEventForHash(record, record.prevHash, record.auditKeyId),
          );
          hash = computeEventHash(canonical, record.prevHash);
        } catch {
          return failed("hash_mismatch", record.eventId, range(checkedFrom, checkedTo));
        }
        if (!hash.equals(record.hash)) {
          return failed("hash_mismatch", record.eventId, range(checkedFrom, checkedTo));
        }
        if (firstWalked && atFirst !== undefined && !hash.equals(atFirst.last_hash)) {
          return failed("checkpoint_mismatch", record.eventId, range(checkedFrom, checkedTo));
        }
        let key: Buffer;
        try {
          key = await this.#key(record.auditKeyId, keys);
        } catch (error) {
          if (error instanceof AuditKeyUnavailableError) {
            return failed("key_unavailable", record.eventId, range(checkedFrom, checkedTo));
          }
          throw error;
        }
        if (!safeEqual(computeEventHmac(key, record.hash), record.hmac)) {
          return failed("hmac_mismatch", record.eventId, range(checkedFrom, checkedTo));
        }
        checkedFrom ??= record.eventId;
        checkedTo = record.eventId;
        expectedPrevious = record.hash;
        firstWalked = false;
        afterId = record.sequenceId;
      }
      if (rows.records.length < BATCH_SIZE) {
        break;
      }
    }

    const checkpoints = await this.#database.executeQuery<CheckpointRow>(
      `SELECT id, last_event_id, last_hash, hmac, audit_key_id
         FROM audit_checkpoints
        WHERE last_event_id >= CAST(:firstId AS bigint)
        ORDER BY last_event_id ASC`,
      { firstId },
    );
    for (const checkpoint of checkpoints.records) {
      const checked = await this.#checkCheckpoint(
        checkpoint,
        keys,
        firstId,
        firstEventId,
        range(checkedFrom, checkedTo),
      );
      if (checked !== undefined) {
        return checked;
      }
      const event = await this.#database.executeQuery<{ hash: Buffer }>(
        "SELECT hash FROM audit_events WHERE id = CAST(:id AS bigint)",
        { id: checkpoint.last_event_id },
      );
      const stored = event.records[0];
      if (stored === undefined || !stored.hash.equals(checkpoint.last_hash)) {
        return failed(
          "tail_truncated",
          checkpoint.last_event_id === firstId ? firstEventId : null,
          range(checkedFrom, checkedTo),
        );
      }
    }

    return {
      ok: true,
      checkedRange: range(checkedFrom, checkedTo),
      firstBrokenEventId: null,
      reason: "ok",
    };
  }

  /** Verifies one checkpoint key and HMAC. */
  async #checkCheckpoint(
    checkpoint: CheckpointRow,
    keys: Map<string, Buffer>,
    firstSequenceId: string,
    firstEventId: string,
    checkedRange: AuditVerifyResult["checkedRange"],
  ): Promise<AuditVerifyResult | undefined> {
    const atFirst = checkpoint.last_event_id === firstSequenceId;
    let key: Buffer;
    try {
      key = await this.#key(checkpoint.audit_key_id, keys);
    } catch (error) {
      if (error instanceof AuditKeyUnavailableError) {
        return failed("key_unavailable", atFirst ? firstEventId : null, checkedRange);
      }
      throw error;
    }
    const expected = computeCheckpointHmac(key, checkpoint.last_event_id, checkpoint.last_hash);
    if (!safeEqual(expected, checkpoint.hmac)) {
      return failed("checkpoint_mismatch", atFirst ? firstEventId : null, checkedRange);
    }
    return undefined;
  }
}

/** Compares two byte strings without an early exit. */
function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Builds a checked range or null when nothing was checked. */
function range(
  fromEventId: string | null,
  toEventId: string | null,
): AuditVerifyResult["checkedRange"] {
  if (fromEventId === null || toEventId === null) {
    return null;
  }
  return { fromEventId, toEventId };
}
