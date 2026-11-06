import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { AuditWriter } from "../../audit/audit-writer.js";
import type { CertificateExpiryRepository, NotificationClaim } from "./repository.js";
import type { CertificateExpiryWebhook, ExpiryWebhookPayload } from "./webhook.js";

const DAY_MS = 86_400_000;
const EXPIRY_BATCH = 500;

/** Minimal logger surface used by the expiry job. */
export interface ExpiryLogger {
  /** Logs one informational record. */
  info(message: string, data?: Record<string, unknown>): Promise<void> | void;
  /** Logs one error record. */
  error(message: string, data?: Record<string, unknown>): Promise<void> | void;
}

/** Summary returned by one scan. */
export interface ExpiryRunSummary {
  /** Certificates inside the window. */
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

/** Selects the warning threshold from the raw remaining milliseconds. */
export function thresholdFor(remainingMs: number): 7 | 14 | 30 | undefined {
  if (remainingMs <= 0 || remainingMs > 30 * DAY_MS) {
    return undefined;
  }
  if (remainingMs > 14 * DAY_MS) {
    return 30;
  }
  if (remainingMs > 7 * DAY_MS) {
    return 14;
  }
  return 7;
}

/** Options for {@link CertificateExpiryService}. */
export interface CertificateExpiryServiceOptions {
  /** Connected database. */
  readonly database: PostgreSQLDatabase;
  /** Expiry persistence. */
  readonly repository: CertificateExpiryRepository;
  /** Optional webhook. */
  readonly webhook?: CertificateExpiryWebhook;
  /** Audit writer. */
  readonly audit: AuditWriter;
  /** Logger. */
  readonly logger: ExpiryLogger;
  /** Injectable clock. */
  readonly now?: () => number;
}

/**
 * Daily certificate expiry scan.
 *
 * The claim, webhook, audit, and mark-sent steps use separate short transactions. The service
 * never holds a notification row lock while taking the audit chain lock, so it cannot deadlock
 * with the purger's chain-first order.
 */
export class CertificateExpiryService {
  readonly #database: PostgreSQLDatabase;
  readonly #repository: CertificateExpiryRepository;
  readonly #webhook: CertificateExpiryWebhook | undefined;
  readonly #audit: AuditWriter;
  readonly #logger: ExpiryLogger;
  readonly #now: () => number;

  /**
   * @param options - Database, repository, webhook, audit, logger, and clock.
   */
  public constructor(options: CertificateExpiryServiceOptions) {
    this.#database = options.database;
    this.#repository = options.repository;
    this.#webhook = options.webhook;
    this.#audit = options.audit;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Runs one expiry scan.
   *
   * @returns Scan counts.
   */
  public async runOnce(): Promise<ExpiryRunSummary> {
    const now = new Date(this.#now());
    const runId = newUlid();
    const requestId = `certificate-expiry-${runId}`;
    let cursor: { readonly notAfter: Date; readonly certificateId: string } | undefined;
    let scanned = 0;
    let claimed = 0;
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    do {
      const rows = await this.#repository.listExpiring(this.#database, now, cursor, EXPIRY_BATCH);
      scanned += rows.length;
      for (const row of rows) {
        const remaining = row.notAfter.getTime() - now.getTime();
        const thresholdDays = thresholdFor(remaining);
        if (thresholdDays === undefined) {
          skipped += 1;
          continue;
        }
        const daysToExpiry = Math.ceil(remaining / DAY_MS);
        const claim = await this.#claim(row, thresholdDays, daysToExpiry, now);
        if (claim === undefined) {
          skipped += 1;
          continue;
        }
        claimed += 1;
        if (
          !(await this.#repository.isEligible(
            this.#database,
            row.certificateId,
            row.versionId,
            now,
          ))
        ) {
          skipped += 1;
          try {
            await this.#database.withTransaction(async (tx) =>
              this.#repository.deleteClaim(tx, claim.id),
            );
          } catch {
            // A stale pending claim is reclaimed after the lease.
          }
          continue;
        }
        const payload: ExpiryWebhookPayload = {
          event: "certificate.expiry_warning",
          eventId: `${row.certificateId}:${row.versionId}:${thresholdDays}`,
          certificateId: row.certificateId,
          projectId: row.projectId,
          name: row.name,
          versionId: row.versionId,
          fingerprint: row.fingerprint,
          notAfter: row.notAfter.toISOString(),
          daysToExpiry,
          thresholdDays,
          occurredAt: now.toISOString(),
        };
        try {
          if (this.#webhook !== undefined) {
            await this.#webhook.send(payload);
          }
        } catch {
          failed += 1;
          await this.#logger.error("certificate expiry delivery failed", {
            certificateId: row.certificateId,
            versionId: row.versionId,
            thresholdDays,
            daysToExpiry,
            reason: "webhook_failed",
          });
          try {
            await this.#writeAudit(
              claim,
              requestId,
              row.projectId,
              {
                thresholdDays,
                daysToExpiry,
                version: row.versionId,
                webhook: "failed",
                reason: "webhook_failed",
              },
              "error",
            );
          } catch {
            // The claim is still removed so a later run can retry.
          }
          try {
            await this.#database.withTransaction(async (tx) =>
              this.#repository.deleteClaim(tx, claim.id),
            );
          } catch {
            // A stale pending claim is reclaimed after the lease.
          }
          continue;
        }
        try {
          await this.#writeAudit(claim, requestId, row.projectId, {
            thresholdDays,
            daysToExpiry,
            version: row.versionId,
            webhook: this.#webhook === undefined ? "skipped" : "sent",
          });
        } catch {
          failed += 1;
          await this.#logger.error("certificate expiry audit failed", {
            certificateId: row.certificateId,
            versionId: row.versionId,
            thresholdDays,
            reason: "audit_failed",
          });
          try {
            await this.#database.withTransaction(async (tx) =>
              this.#repository.deleteClaim(tx, claim.id),
            );
          } catch {
            // A stale pending claim is reclaimed after the lease.
          }
          continue;
        }
        try {
          await this.#database.withTransaction(async (tx) =>
            this.#repository.markSent(tx, claim.id),
          );
        } catch {
          failed += 1;
          await this.#logger.error("certificate expiry mark-sent failed", {
            certificateId: row.certificateId,
            versionId: row.versionId,
            thresholdDays,
            reason: "mark_sent_failed",
          });
          continue;
        }
        sent += 1;
        await this.#logger.info("certificate expiry warning", {
          certificateId: row.certificateId,
          versionId: row.versionId,
          thresholdDays,
          daysToExpiry,
          webhook: this.#webhook === undefined ? "skipped" : "sent",
        });
      }
      const last = rows[rows.length - 1];
      cursor =
        rows.length === EXPIRY_BATCH && last !== undefined
          ? { notAfter: last.notAfter, certificateId: last.certificateId }
          : undefined;
    } while (cursor !== undefined);
    return { scanned, claimed, sent, failed, skipped };
  }

  /** Claims one row in a short transaction, reclaiming a stale pending row. */
  async #claim(
    row: {
      readonly certificateId: string;
      readonly projectId: string;
      readonly versionId: string;
    },
    thresholdDays: 7 | 14 | 30,
    daysToExpiry: number,
    now: Date,
  ): Promise<NotificationClaim | undefined> {
    return this.#database.withTransaction(async (tx) =>
      this.#repository.claim(tx, {
        certificateId: row.certificateId,
        projectId: row.projectId,
        versionId: row.versionId,
        thresholdDays,
        daysToExpiry,
        auditEventId: newUlid(),
        now,
      }),
    );
  }

  /** Writes one audit outcome unless an allow already exists for the claim. */
  async #writeAudit(
    claim: NotificationClaim,
    requestId: string,
    projectId: string,
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
      projectId,
      requestId,
      actorId: null,
      actorKind: "system",
      action: "certificate.expiry_warning",
      scopeType: "object",
      scopeId: claim.certificateId,
      objectType: "certificate",
      objectId: claim.certificateId,
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
