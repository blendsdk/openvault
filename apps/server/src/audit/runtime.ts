import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { KeyringProvider } from "../security/keyring.js";
import { AuditWriter } from "./audit-writer.js";
import { PersistentPolicyAudit } from "./policy-audit.js";

/** Writer and adapter that can be built before the policy engine. */
export interface AuditCore {
  /** Chain writer shared by every emitter. */
  readonly writer: AuditWriter;
  /** Adapter behind the existing policy audit port. */
  readonly policyAudit: PersistentPolicyAudit;
}

/**
 * Builds the audit pieces that do not depend on the policy engine.
 *
 * Composition order matters: the policy engine needs this adapter, and the
 * query/verify service needs the policy engine for `audit.read` authorization.
 *
 * @param options - Connected database, loaded keyring, and optional clock.
 * @returns The writer and policy adapter.
 */
export function createAuditCore(options: {
  readonly database: PostgreSQLDatabase;
  /** Pool for decisions that must commit independently of a caller transaction. */
  readonly independentDatabase?: PostgreSQLDatabase;
  readonly keyring: KeyringProvider;
  readonly now?: () => number;
}): AuditCore {
  const writer = new AuditWriter({
    database: options.database,
    ...(options.independentDatabase === undefined
      ? {}
      : { independentDatabase: options.independentDatabase }),
    keyring: options.keyring,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const policyAudit = new PersistentPolicyAudit({
    writer,
    database: options.database,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { writer, policyAudit };
}
