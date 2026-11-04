import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { Logger } from "blendsdk/webafx";
import { AssignmentService } from "./assignment-service.js";
import { LoggingPolicyAudit, type PolicyAuditPort } from "./audit.js";
import { PolicyRepository } from "./policy-repository.js";
import { PolicyService } from "./policy-service.js";
import { createRbacRateLimitService, type RbacRateLimitService } from "./rate-limits.js";

const silentLogger: Logger = {
  info: async () => undefined,
  error: async () => undefined,
  warn: async () => undefined,
  debug: async () => undefined,
};

/** The policy collaborators shared by the application and tests. */
export interface PolicyRuntime {
  /** Policy persistence. */
  readonly repository: PolicyRepository;
  /** Decision and mutation audit sink. */
  readonly audit: PolicyAuditPort;
  /** Decision engine. */
  readonly service: PolicyService;
  /** Assignment administration. */
  readonly assignments: AssignmentService;
  /** Admin write/read limiters. */
  readonly rateLimits: RbacRateLimitService;
}

/**
 * Builds the policy runtime.
 *
 * When a persistent audit adapter is supplied, every decision and mutation is
 * written to the audit chain. Isolated tests that do not need persistence keep
 * the structured-logger adapter.
 *
 * @param options - Database, optional logger, audit adapter, and existing engine.
 * @returns The composed runtime.
 */
export function createPolicyRuntime(options: {
  readonly database: PostgreSQLDatabase;
  readonly logger?: Logger;
  /** Persistent adapter, or the logger adapter when omitted. */
  readonly audit?: PolicyAuditPort;
  /** Reuse an existing engine when the caller already owns one. */
  readonly service?: PolicyService;
}): PolicyRuntime {
  const audit = options.audit ?? new LoggingPolicyAudit(options.logger ?? silentLogger);
  const repository = new PolicyRepository(options.database);
  const service = options.service ?? new PolicyService({ repository, audit });
  const assignments = new AssignmentService({
    database: options.database,
    repository,
    policy: service,
    audit,
  });
  return { repository, audit, service, assignments, rateLimits: createRbacRateLimitService() };
}
