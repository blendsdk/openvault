import type { QueryExecutor } from "../repository.js";

/** One certificate whose current version is inside the warning window. */
export interface ExpiringCertificate {
  /** Certificate identifier. */
  readonly certificateId: string;
  /** Project identifier. */
  readonly projectId: string;
  /** Certificate name. */
  readonly name: string;
  /** Version identifier. */
  readonly versionId: string;
  /** Leaf fingerprint. */
  readonly fingerprint: string;
  /** Validity end. */
  readonly notAfter: Date;
}

/** One durable warning claim. */
export interface NotificationClaim {
  /** Notification row identifier (bigint as a string). */
  readonly id: string;
  /** Certificate identifier. */
  readonly certificateId: string;
  /** Version identifier. */
  readonly versionId: string;
  /** Threshold in days. */
  readonly thresholdDays: 7 | 14 | 30;
  /** Days remaining when claimed. */
  readonly daysToExpiry: number;
  /** Stable audit event identifier. */
  readonly auditEventId: string;
}

interface ClaimRow {
  readonly id: string;
  readonly certificate_id: string;
  readonly version_id: string;
  readonly threshold_days: number;
  readonly days_to_expiry: number;
  readonly status: string;
  readonly claimed_at: Date;
  readonly audit_event_id: string;
}

/**
 * Reads expiring certificates and owns the durable notification claim.
 *
 * Claims lock the project and certificate rows, so a concurrent delete, recovery, or renewal
 * cannot commit between the active-state check and the claim.
 */
export class CertificateExpiryRepository {
  /**
   * Lists active current versions inside the 30-day window.
   *
   * @param executor - Database.
   * @param now - Service clock.
   * @returns Expiring certificates ordered by expiry.
   */
  public async listExpiring(
    executor: QueryExecutor,
    now: Date,
  ): Promise<readonly ExpiringCertificate[]> {
    const until = new Date(now.getTime() + 30 * 86_400_000);
    const result = await executor.executeQuery<{
      certificate_id: string;
      project_id: string;
      name: string;
      version_id: string;
      fingerprint: string;
      not_after: Date;
    }>(
      `SELECT c.id AS certificate_id, c.project_id, c.name, v.id AS version_id,
              v.fingerprint, v.not_after
         FROM certificates c
         JOIN projects p ON p.id = c.project_id
         JOIN certificate_versions v ON v.id = c.current_version_id
        WHERE c.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND v.not_after > :now
          AND v.not_after <= :until
        ORDER BY v.not_after ASC, c.id ASC`,
      { now, until },
    );
    return result.records.map((row) => ({
      certificateId: row.certificate_id,
      projectId: row.project_id,
      name: row.name,
      versionId: row.version_id,
      fingerprint: row.fingerprint,
      notAfter: row.not_after,
    }));
  }

  /**
   * Claims one warning, reclaiming a stale pending row after the one-hour lease.
   *
   * @param executor - Transaction.
   * @param input - Certificate, version, threshold, and current values.
   * @returns The claim, or undefined when another live process owns it.
   */
  public async claim(
    executor: QueryExecutor,
    input: {
      readonly certificateId: string;
      readonly projectId: string;
      readonly versionId: string;
      readonly thresholdDays: 7 | 14 | 30;
      readonly daysToExpiry: number;
      readonly auditEventId: string;
      readonly now: Date;
    },
  ): Promise<NotificationClaim | undefined> {
    const locked = await executor.executeQuery<{ id: string }>(
      `SELECT c.id
         FROM certificates c
         JOIN projects p ON p.id = c.project_id
         JOIN certificate_versions v ON v.id = c.current_version_id
        WHERE c.id = :certificateId
          AND c.project_id = :projectId
          AND c.current_version_id = :versionId
          AND c.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND v.not_after > :now
          FOR SHARE OF c, p`,
      { ...input },
    );
    if (locked.records.length !== 1) {
      return undefined;
    }
    const inserted = await executor.executeQuery<ClaimRow>(
      `INSERT INTO certificate_expiry_notifications
         (certificate_id, version_id, threshold_days, days_to_expiry, status,
          audit_event_id, claimed_at)
       VALUES
         (:certificateId, :versionId, :thresholdDays, :daysToExpiry, 'pending',
          :auditEventId, :now)
       ON CONFLICT (version_id, threshold_days) DO NOTHING
       RETURNING id, certificate_id, version_id, threshold_days, days_to_expiry, status,
                 claimed_at, audit_event_id`,
      { ...input },
    );
    const row = inserted.records[0];
    if (row !== undefined) {
      return this.#toClaim(row);
    }
    const existing = await executor.executeQuery<ClaimRow>(
      `SELECT id, certificate_id, version_id, threshold_days, days_to_expiry, status,
              claimed_at, audit_event_id
         FROM certificate_expiry_notifications
        WHERE version_id = :versionId AND threshold_days = :thresholdDays
        FOR UPDATE`,
      { ...input },
    );
    const current = existing.records[0];
    if (current === undefined || current.status === "sent") {
      return undefined;
    }
    if (current.claimed_at.getTime() > input.now.getTime() - 3_600_000) {
      return undefined;
    }
    const priorResult = await this.auditEventResult(executor, current.audit_event_id);
    const auditEventId = priorResult === "error" ? input.auditEventId : current.audit_event_id;
    const updated = await executor.executeQuery<ClaimRow>(
      `UPDATE certificate_expiry_notifications
          SET claimed_at = :now, days_to_expiry = :daysToExpiry, audit_event_id = :auditEventId
        WHERE id = :id
        RETURNING id, certificate_id, version_id, threshold_days, days_to_expiry, status,
                  claimed_at, audit_event_id`,
      { ...input, id: current.id, auditEventId },
    );
    const claim = updated.records[0];
    return claim === undefined ? undefined : this.#toClaim(claim);
  }

  /**
   * Marks one claim sent.
   *
   * @param executor - Transaction.
   * @param claimId - Notification row identifier.
   */
  public async markSent(executor: QueryExecutor, claimId: string): Promise<void> {
    await executor.executeQuery(
      "UPDATE certificate_expiry_notifications SET status = 'sent', sent_at = now() WHERE id = :claimId",
      { claimId },
    );
  }

  /**
   * Deletes one claim so a later run can retry.
   *
   * @param executor - Transaction.
   * @param claimId - Notification row identifier.
   */
  public async deleteClaim(executor: QueryExecutor, claimId: string): Promise<void> {
    await executor.executeQuery(
      "DELETE FROM certificate_expiry_notifications WHERE id = :claimId",
      { claimId },
    );
  }

  /**
   * Returns the result of a prior audit event, when it exists.
   *
   * @param executor - Database.
   * @param eventId - Audit event identifier.
   * @returns The stored result, or undefined.
   */
  public async auditEventResult(
    executor: QueryExecutor,
    eventId: string,
  ): Promise<"allow" | "error" | undefined> {
    const result = await executor.executeQuery<{ result: "allow" | "error" | "deny" }>(
      "SELECT result FROM audit_events WHERE event_id = :eventId",
      { eventId },
    );
    const value = result.records[0]?.result;
    return value === "allow" || value === "error" ? value : undefined;
  }

  /** Maps a row to the claim shape. */
  #toClaim(row: ClaimRow): NotificationClaim {
    return {
      id: row.id,
      certificateId: row.certificate_id,
      versionId: row.version_id,
      thresholdDays: row.threshold_days as 7 | 14 | 30,
      daysToExpiry: row.days_to_expiry,
      auditEventId: row.audit_event_id,
    };
  }
}
