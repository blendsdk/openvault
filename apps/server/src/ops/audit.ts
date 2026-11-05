import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import { AuditWriter } from "../audit/audit-writer.js";
import type { KeyringProvider } from "../security/keyring.js";
import { OpsError } from "./errors.js";

/** The system actor used by local operations. */
const OPERATIONS_REQUEST_ID = "operations";

/** Records one successful or failed operations event. */
export async function recordOperationsEvent(options: {
  readonly database: PostgreSQLDatabase;
  readonly keyring: KeyringProvider;
  readonly action: "backup.create" | "backup.restore" | "kek.rotate";
  readonly result: "allow" | "error";
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
  readonly now?: () => number;
  readonly requestId?: string;
}): Promise<void> {
  const writer = new AuditWriter({
    database: options.database,
    keyring: options.keyring,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  try {
    await writer.record({
      eventId: newUlid(),
      ts: new Date((options.now ?? Date.now)()),
      projectId: null,
      requestId: options.requestId ?? OPERATIONS_REQUEST_ID,
      actorId: null,
      actorKind: "system",
      action: options.action,
      scopeType: "system",
      scopeId: null,
      objectType: null,
      objectId: null,
      result: options.result,
      sourceIp: null,
      userAgent: null,
      details: options.details,
    });
  } catch (error) {
    throw new OpsError("ops_configuration", "The operations audit event could not be recorded", {
      cause: error,
    });
  }
}
