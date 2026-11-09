import type { QueryExecutor } from "../../identity/identity-repository.js";
import { daysUntilDue, type RotationStatus } from "./state.js";

/** One secret whose rotation is due or inside the warning window. */
export interface RotationCandidate {
  /** Secret identifier. */
  readonly secretId: string;
  /** Project identifier. */
  readonly projectId: string;
  /** Secret name. */
  readonly name: string;
  /** Current version identifier. */
  readonly versionId: string;
  /** Derived due date. */
  readonly dueAt: Date;
  /** Live status at scan time. */
  readonly status: Exclude<RotationStatus, "ok">;
  /** Whole days until the due date; negative when overdue. */
  readonly daysUntilDue: number;
}

/** Keyset cursor for the rotation scan. */
export interface RotationCursor {
  /** Last due date on the previous page. */
  readonly dueAt: Date;
  /** Last secret identifier on the previous page. */
  readonly secretId: string;
}

/** One durable rotation warning claim. */
export interface RotationClaim {
  /** Notification row identifier. */
  readonly id: string;
  /** Secret identifier. */
  readonly secretId: string;
  /** Project identifier. */
  readonly projectId: string;
  /** Version identifier. */
  readonly versionId: string;
  /** Warning status. */
  readonly status: "due_soon" | "overdue";
  /** Due date at claim time. */
  readonly dueAt: Date;
  /** Whole days until the due date at claim time. */
  readonly daysUntilDue: number;
  /** Stable audit event identifier. */
  readonly auditEventId: string;
}

interface ClaimRow {
  readonly id: string;
  readonly secret_id: string;
  readonly project_id: string;
  readonly version_id: string;
  readonly status: "due_soon" | "overdue";
  readonly due_at: Date;
  readonly days_until_due: number;
  readonly audit_event_id: string | null;
  readonly claimed_at: Date | null;
  readonly sent_at: Date | null;
}

const CLAIM_COLUMNS = `id, secret_id, project_id, version_id, status, due_at,
  days_until_due, audit_event_id, claimed_at, sent_at`;

/**
 * Reads eligible rotation rows and owns the durable warning claim.
 *
 * Claims lock the secret and project rows with `FOR SHARE`, matching the
 * certificate-expiry repository. That lock prevents a concurrent purge from
 * deleting the target between the eligibility check and the claim commit.
 */
export class SecretRotationRepository {
  /**
   * Lists current versions whose rotation is due or inside the warning window.
   *
   * @param executor - Database.
   * @param now - Service clock.
   * @param warningDays - Due-soon window in days.
   * @param cursor - Optional keyset cursor.
   * @param limit - Maximum rows to read.
   * @returns Eligible secrets ordered by due date and secret id.
   */
  public async listEligible(
    executor: QueryExecutor,
    now: Date,
    warningDays: number,
    cursor?: RotationCursor,
    limit = 500,
  ): Promise<readonly RotationCandidate[]> {
    const until = new Date(now.getTime() + warningDays * 86_400_000);
    const conditions = [
      "s.deleted_at IS NULL",
      "p.deleted_at IS NULL",
      "s.rotation_interval_days IS NOT NULL",
      "v.created_at + make_interval(days => s.rotation_interval_days) <= :until",
    ];
    const params: Record<string, unknown> = { until, limit };
    if (cursor !== undefined) {
      conditions.push(
        `(v.created_at + make_interval(days => s.rotation_interval_days), s.id)
           > (:afterDueAt, :afterId)`,
      );
      params.afterDueAt = cursor.dueAt;
      params.afterId = cursor.secretId;
    }
    const result = await executor.executeQuery<{
      readonly secret_id: string;
      readonly project_id: string;
      readonly name: string;
      readonly version_id: string;
      readonly due_at: Date;
    }>(
      `SELECT s.id AS secret_id, s.project_id, s.name, v.id AS version_id,
              v.created_at + make_interval(days => s.rotation_interval_days) AS due_at
         FROM secrets s
         JOIN projects p ON p.id = s.project_id
         JOIN secret_versions v ON v.id = s.current_version_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY due_at ASC, s.id ASC
        LIMIT :limit`,
      params,
    );
    return result.records.map((row) => ({
      secretId: row.secret_id,
      projectId: row.project_id,
      name: row.name,
      versionId: row.version_id,
      dueAt: row.due_at,
      status: row.due_at.getTime() <= now.getTime() ? "overdue" : "due_soon",
      daysUntilDue: daysUntilDue(row.due_at, now.getTime()),
    }));
  }

  /**
   * Re-checks that the secret, project, version, and exact due date are current.
   *
   * @param executor - Database.
   * @param secretId - Secret identifier.
   * @param versionId - Current version identifier.
   * @param dueAt - Due date that was scanned.
   * @param now - Service clock.
   * @returns True when the warning is still eligible.
   */
  public async isEligible(
    executor: QueryExecutor,
    secretId: string,
    versionId: string,
    dueAt: Date,
    now: Date,
    warningDays: number,
  ): Promise<boolean> {
    const result = await executor.executeQuery<{ readonly id: string }>(
      `SELECT s.id
         FROM secrets s
         JOIN projects p ON p.id = s.project_id
         JOIN secret_versions v ON v.id = s.current_version_id
        WHERE s.id = :secretId
          AND s.current_version_id = :versionId
          AND s.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND s.rotation_interval_days IS NOT NULL
          AND v.created_at + make_interval(days => s.rotation_interval_days) = :dueAt
          AND :dueAt <= :until
          FOR SHARE OF s, p`,
      {
        secretId,
        versionId,
        dueAt,
        until: new Date(now.getTime() + warningDays * 86_400_000),
      },
    );
    return result.records.length === 1;
  }

  /**
   * Claims one warning, reclaiming a stale row after the one-hour lease.
   *
   * @param executor - Transaction.
   * @param input - Secret, version, status, due date, and audit identifiers.
   * @returns The claim, or undefined when another live process owns it.
   */
  public async claim(
    executor: QueryExecutor,
    input: {
      readonly id: string;
      readonly secretId: string;
      readonly projectId: string;
      readonly versionId: string;
      readonly status: "due_soon" | "overdue";
      readonly dueAt: Date;
      readonly daysUntilDue: number;
      readonly auditEventId: string;
      readonly now: Date;
    },
  ): Promise<RotationClaim | undefined> {
    const locked = await executor.executeQuery<{ readonly id: string }>(
      `SELECT s.id
         FROM secrets s
         JOIN projects p ON p.id = s.project_id
         JOIN secret_versions v ON v.id = s.current_version_id
        WHERE s.id = :secretId
          AND s.project_id = :projectId
          AND s.current_version_id = :versionId
          AND s.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND s.rotation_interval_days IS NOT NULL
          AND v.created_at + make_interval(days => s.rotation_interval_days) = :dueAt
          FOR SHARE OF s, p`,
      { ...input },
    );
    if (locked.records.length !== 1) {
      return undefined;
    }
    const inserted = await executor.executeQuery<ClaimRow>(
      `INSERT INTO secret_rotation_notifications
         (id, secret_id, project_id, version_id, status, due_at, days_until_due,
          audit_event_id, claimed_at)
       VALUES
         (:id, :secretId, :projectId, :versionId, :status, :dueAt, :daysUntilDue,
          :auditEventId, :now)
       ON CONFLICT (secret_id, version_id, status, due_at) DO NOTHING
       RETURNING ${CLAIM_COLUMNS}`,
      { ...input },
    );
    const row = inserted.records[0];
    if (row !== undefined) {
      return this.#toClaim(row);
    }
    const existing = await executor.executeQuery<ClaimRow>(
      `SELECT ${CLAIM_COLUMNS}
         FROM secret_rotation_notifications
        WHERE secret_id = :secretId AND version_id = :versionId
          AND status = :status AND due_at = :dueAt
        FOR UPDATE`,
      { ...input },
    );
    const current = existing.records[0];
    if (current === undefined || current.sent_at !== null) {
      return undefined;
    }
    if (
      current.claimed_at !== null &&
      current.claimed_at.getTime() > input.now.getTime() - 3_600_000
    ) {
      return undefined;
    }
    const prior = await this.auditEventResult(executor, current.audit_event_id);
    const auditEventId = prior === "error" ? input.auditEventId : current.audit_event_id;
    const updated = await executor.executeQuery<ClaimRow>(
      `UPDATE secret_rotation_notifications
          SET claimed_at = :now, days_until_due = :daysUntilDue,
              audit_event_id = :auditEventId
        WHERE id = :rowId
        RETURNING ${CLAIM_COLUMNS}`,
      {
        ...input,
        rowId: current.id,
        auditEventId: auditEventId ?? input.auditEventId,
      },
    );
    const claim = updated.records[0];
    return claim === undefined ? undefined : this.#toClaim(claim);
  }

  /**
   * Stores a newly generated audit event identifier on a claim.
   *
   * @param executor - Database or transaction.
   * @param claimId - Notification row identifier.
   * @param auditEventId - New audit event identifier.
   */
  public async setAuditEventId(
    executor: QueryExecutor,
    claimId: string,
    auditEventId: string,
  ): Promise<void> {
    await executor.executeQuery(
      "UPDATE secret_rotation_notifications SET audit_event_id = :auditEventId WHERE id = :claimId",
      { claimId, auditEventId },
    );
  }

  /**
   * Marks one claim sent.
   *
   * @param executor - Transaction.
   * @param claimId - Notification row identifier.
   */
  public async markSent(executor: QueryExecutor, claimId: string): Promise<void> {
    await executor.executeQuery(
      "UPDATE secret_rotation_notifications SET sent_at = now() WHERE id = :claimId",
      { claimId },
    );
  }

  /**
   * Deletes one claim so a later scan can retry.
   *
   * @param executor - Transaction.
   * @param claimId - Notification row identifier.
   */
  public async deleteClaim(executor: QueryExecutor, claimId: string): Promise<void> {
    await executor.executeQuery("DELETE FROM secret_rotation_notifications WHERE id = :claimId", {
      claimId,
    });
  }

  /**
   * Returns the result of a prior audit event, when it exists.
   *
   * @param executor - Database or transaction.
   * @param eventId - Audit event identifier, or null.
   * @returns The stored result, or undefined.
   */
  public async auditEventResult(
    executor: QueryExecutor,
    eventId: string | null,
  ): Promise<"allow" | "error" | undefined> {
    if (eventId === null) {
      return undefined;
    }
    const result = await executor.executeQuery<{ readonly result: "allow" | "deny" | "error" }>(
      "SELECT result FROM audit_events WHERE event_id = :eventId",
      { eventId },
    );
    const value = result.records[0]?.result;
    return value === "allow" || value === "error" ? value : undefined;
  }

  /** Maps one row to the claim shape. */
  #toClaim(row: ClaimRow): RotationClaim {
    return {
      id: row.id,
      secretId: row.secret_id,
      projectId: row.project_id,
      versionId: row.version_id,
      status: row.status,
      dueAt: row.due_at,
      daysUntilDue: row.days_until_due,
      auditEventId: row.audit_event_id ?? "",
    };
  }
}
