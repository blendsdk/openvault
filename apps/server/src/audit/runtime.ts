import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { PolicyService } from "../rbac/policy-service.js";
import type { KeyringProvider } from "../security/keyring.js";
import { AuditExporter } from "./audit-export.js";
import { AuditEventQuery } from "./audit-query.js";
import {
  type AuditRateLimitOptions,
  type AuditRateLimitService,
  createAuditRateLimitService,
} from "./audit-rate-limits.js";
import { AuditService } from "./audit-service.js";
import { AuditVerifier } from "./audit-verify.js";
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

/** Full audit collaborators, including the policy-dependent service. */
export interface AuditRuntime extends AuditCore {
  /** Query, verify, export, and record facade. */
  readonly service: AuditService;
  /** Endpoint rate limiters. */
  readonly rateLimits: AuditRateLimitService;
}

/**
 * Builds the full audit runtime after the policy engine exists.
 *
 * The policy engine needs the adapter from {@link createAuditCore}; this
 * second step builds the query, verifier, exporter, and service that need the
 * policy engine for `audit.read`.
 *
 * @param options - Core, policy engine, database, keyring, and limiter overrides.
 * @returns The full runtime.
 */
export function createAuditRuntime(options: {
  readonly core: AuditCore;
  readonly policy: PolicyService;
  readonly database: PostgreSQLDatabase;
  readonly keyring: KeyringProvider;
  readonly now?: () => number;
  readonly rateLimitOptions?: AuditRateLimitOptions;
}): AuditRuntime {
  const query = new AuditEventQuery({
    database: options.database,
    keyring: options.keyring,
  });
  const verifier = new AuditVerifier({
    database: options.database,
    keyring: options.keyring,
  });
  const exporter = new AuditExporter({
    database: options.database,
    keyring: options.keyring,
  });
  const service = new AuditService({
    writer: options.core.writer,
    query,
    verifier,
    exporter,
    policy: options.policy,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const rateLimits = createAuditRateLimitService(options.rateLimitOptions);
  return { ...options.core, service, rateLimits };
}
