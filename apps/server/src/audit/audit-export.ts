import type { AuditEvent, AuditExportQuery } from "@openvault/api-contract";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { KeyringProvider } from "../security/keyring.js";
import { AuditEventQuery } from "./audit-query.js";
import type { AuditEventRecord, AuditVisibility } from "./types.js";

const EXPORT_BATCH = 500;

/** Converts one internal record into the public event shape. */
export function toPublicEvent(record: AuditEventRecord): AuditEvent {
  return {
    eventId: record.eventId,
    ts: record.ts.toISOString(),
    projectId: record.projectId,
    requestId: record.requestId,
    actorId: record.actorId,
    actorKind: record.actorKind,
    action: record.action,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    objectType: record.objectType,
    objectId: record.objectId,
    result: record.result,
    sourceIp: record.sourceIp,
    userAgent: record.userAgent,
    details: record.details,
    prevHash: record.prevHash.toString("hex"),
    hash: record.hash.toString("hex"),
    hmac: record.hmac.toString("hex"),
    auditKeyId: record.auditKeyId,
  };
}

/** Export options supplied by the service. */
export interface AuditExportOptions {
  /** Parsed export filters. */
  readonly filters: AuditExportQuery;
  /** Effective project visibility. */
  readonly visibility: AuditVisibility;
  /** Receives one NDJSON line per event. */
  readonly write: (line: string) => Promise<void>;
}

/**
 * Streams matching events as NDJSON.
 *
 * The exporter never buffers the full result set; it writes one batch at a
 * time and awaits each consumer write so a slow client applies backpressure.
 */
export class AuditExporter {
  readonly #query: AuditEventQuery;

  /**
   * @param options - Connected database and loaded keyring.
   */
  public constructor(options: {
    readonly database: PostgreSQLDatabase;
    readonly keyring: KeyringProvider;
  }) {
    this.#query = new AuditEventQuery(options);
  }

  /**
   * Streams every matching event in ascending sequence order.
   *
   * @param options - Filters, visibility, and line writer.
   */
  public async export(options: AuditExportOptions): Promise<void> {
    for await (const batch of this.#query.stream(
      options.filters,
      options.visibility,
      EXPORT_BATCH,
    )) {
      for (const record of batch) {
        await options.write(`${JSON.stringify(toPublicEvent(record))}\n`);
      }
    }
  }
}
