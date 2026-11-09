import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { AuditWriter } from "../../audit/audit-writer.js";
import type { RotationCandidate, RotationClaim, SecretRotationRepository } from "./repository.js";
import type { RotationWebhookPayload, SecretRotationWebhook } from "./webhook.js";

const ROTATION_BATCH = 500;

/** Minimal logger surface used by the rotation scan. */
export interface RotationLogger {
  /** Logs one informational record. */
  info(message: string, data?: Record<string, unknown>): Promise<void> | void;
  /** Logs one error record. */
  error(message: string, data?: Record<string, unknown>): Promise<void> | void;
}

/** Summary returned by one rotation scan. */
export interface RotationRunSummary {
  /** Secrets inside the warning window or overdue. */
  readonly scanned: number;
  /** Claims won by this run. */
  readonly claimed: number;
  /** Warnings delivered and marked sent. */
  readonly sent: number;
  /** Warnings that failed and will retry. */
  readonly failed: number;
  /** Rows skipped because another process owns them or they are no longer eligible. */
  readonly skipped: number;
}

/** Options for {@link SecretRotationService}. */
export interface SecretRotationServiceOptions {
  /** Connected database. */
  readonly database: PostgreSQLDatabase;
  /** Rotation persistence. */
  readonly repository: SecretRotationRepository;
  /** Optional webhook. */
  readonly webhook?: SecretRotationWebhook;
  /** Audit writer. */
  readonly audit: AuditWriter;
  /** Logger. */
  readonly logger: RotationLogger;
  /** Due-soon window in days. */
  readonly warningDays: number;
  /** Injectable clock in milliseconds since the Unix epoch. */
  readonly now?: () => number;
}

/**
 * Daily secret-rotation scan.
 *
 * The claim, delivery, audit, and mark-sent steps use separate short
 * transactions. The service never holds a notification row lock while taking
 * the audit chain lock, so it cannot deadlock with the purge order.
 */
export class SecretRotationService {
  readonly #database: PostgreSQLDatabase;
  readonly #repository: SecretRotationRepository;
  readonly #webhook: SecretRotationWebhook | undefined;
  readonly #audit: AuditWriter;
  readonly #logger: RotationLogger;
  readonly #warningDays: number;
  readonly #now: () => number;

  /**
   * @param options - Database, repository, webhook, audit, logger, warning window, and clock.
   */
  public constructor(options: SecretRotationServiceOptions) {
    this.#database = options.database;
    this.#repository = options.repository;
    this.#webhook = options.webhook;
    this.#audit = options.audit;
    this.#logger = options.logger;
    this.#warningDays = options.warningDays;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Runs one rotation scan.
   *
   * @returns Scan counts.
   */
  public async runOnce(): Promise<RotationRunSummary> {
    const now = new Date(this.#now());
    const runId = newUlid();
    const requestId = `secret-rotation-${runId}`;
    let cursor: { readonly dueAt: Date; readonly secretId: string } | undefined;
    let scanned = 0;
    let claimed = 0;
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    do {
      const rows = await this.#repository.listEligible(
        this.#database,
        now,
        this.#warningDays,
        cursor,
        ROTATION_BATCH,
      );
      scanned += rows.length;
      for (const row of rows) {
        const claim = await this.#claim(row, now);
        if (claim === undefined) {
          skipped += 1;
          continue;
        }
        claimed += 1;
        if (
          !(await this.#repository.isEligible(
            this.#database,
            row.secretId,
            row.versionId,
            row.dueAt,
            now,
            this.#warningDays,
          ))
        ) {
          skipped += 1;
          await this.#deleteClaim(claim);
          continue;
        }
        const payload: RotationWebhookPayload = {
          event: "secret.rotation_warning",
          eventId: `${row.secretId}:${row.versionId}:${row.status}:${row.dueAt.toISOString()}`,
          secretId: row.secretId,
          projectId: row.projectId,
          name: row.name,
          versionId: row.versionId,
          dueAt: row.dueAt.toISOString(),
          daysUntilDue: row.daysUntilDue,
          status: row.status,
          occurredAt: now.toISOString(),
        };
        try {
          if (this.#webhook !== undefined) {
            await this.#webhook.send(payload);
          }
        } catch {
          failed += 1;
          await this.#logger.error("secret rotation delivery failed", {
            secretId: row.secretId,
            versionId: row.versionId,
            status: row.status,
            reason: "webhook_failed",
          });
          try {
            await this.#writeAudit(
              claim,
              requestId,
              row,
              {
                status: row.status,
                daysUntilDue: row.daysUntilDue,
                version: row.versionId,
                webhook: "failed",
                reason: "webhook_failed",
              },
              "error",
            );
          } catch {
            // The claim is removed so a later run can retry.
          }
          await this.#deleteClaim(claim);
          continue;
        }
        try {
          await this.#writeAudit(claim, requestId, row, {
            status: row.status,
            daysUntilDue: row.daysUntilDue,
            version: row.versionId,
            webhook: this.#webhook === undefined ? "skipped" : "sent",
          });
        } catch {
          failed += 1;
          await this.#logger.error("secret rotation audit failed", {
            secretId: row.secretId,
            versionId: row.versionId,
            status: row.status,
            reason: "audit_failed",
          });
          await this.#deleteClaim(claim);
          continue;
        }
        try {
          await this.#database.withTransaction(async (tx) =>
            this.#repository.markSent(tx, claim.id),
          );
        } catch {
          failed += 1;
          await this.#logger.error("secret rotation mark-sent failed", {
            secretId: row.secretId,
            versionId: row.versionId,
            status: row.status,
            reason: "mark_sent_failed",
          });
          continue;
        }
        sent += 1;
        await this.#logger.info("secret rotation warning", {
          secretId: row.secretId,
          versionId: row.versionId,
          status: row.status,
          daysUntilDue: row.daysUntilDue,
          webhook: this.#webhook === undefined ? "skipped" : "sent",
        });
      }
      const last = rows[rows.length - 1];
      cursor =
        rows.length === ROTATION_BATCH && last !== undefined
          ? { dueAt: last.dueAt, secretId: last.secretId }
          : undefined;
    } while (cursor !== undefined);
    return { scanned, claimed, sent, failed, skipped };
  }

  /** Claims one row in a short transaction, reclaiming a stale row. */
  async #claim(row: RotationCandidate, now: Date): Promise<RotationClaim | undefined> {
    return this.#database.withTransaction(async (tx) =>
      this.#repository.claim(tx, {
        id: newUlid(),
        secretId: row.secretId,
        projectId: row.projectId,
        versionId: row.versionId,
        status: row.status,
        dueAt: row.dueAt,
        daysUntilDue: row.daysUntilDue,
        auditEventId: newUlid(),
        now,
      }),
    );
  }

  /** Deletes a claim so a later run can retry. */
  async #deleteClaim(claim: RotationClaim): Promise<void> {
    try {
      await this.#database.withTransaction(async (tx) =>
        this.#repository.deleteClaim(tx, claim.id),
      );
    } catch {
      // A stale claim is reclaimed after the lease.
    }
  }

  /** Writes one audit outcome unless an allow already exists for the claim. */
  async #writeAudit(
    claim: RotationClaim,
    requestId: string,
    row: RotationCandidate,
    details: Readonly<Record<string, string | number>>,
    result: "allow" | "error" = "allow",
  ): Promise<void> {
    const prior = await this.#repository.auditEventResult(this.#database, claim.auditEventId);
    if (prior === "allow" && result === "allow") {
      return;
    }
    const eventId = prior === undefined ? claim.auditEventId : newUlid();
    await this.#audit.record({
      eventId,
      ts: new Date(this.#now()),
      projectId: row.projectId,
      requestId,
      actorId: null,
      actorKind: "system",
      action: "secret.rotation_warning",
      scopeType: "object",
      scopeId: row.secretId,
      objectType: "secret",
      objectId: row.secretId,
      result,
      sourceIp: null,
      userAgent: null,
      details: { ...details },
    });
    if (eventId !== claim.auditEventId && result === "allow") {
      await this.#repository.setAuditEventId(this.#database, claim.id, eventId);
    }
  }
}
