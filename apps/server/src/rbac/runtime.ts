import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { Logger } from "blendsdk/webafx";
import { LoggingPolicyAudit, type PolicyAuditPort } from "./audit.js";
import { PolicyRepository } from "./policy-repository.js";
import { PolicyService } from "./policy-service.js";

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
}

/**
 * Builds the policy runtime.
 *
 * The logger adapter is the only audit implementation in this release; the
 * persistent writer replaces it without changing the policy service.
 *
 * @param options - Database and optional structured logger.
 * @returns The composed runtime.
 */
export function createPolicyRuntime(options: {
  readonly database: PostgreSQLDatabase;
  readonly logger?: Logger;
}): PolicyRuntime {
  const audit = new LoggingPolicyAudit(options.logger ?? silentLogger);
  const repository = new PolicyRepository(options.database);
  const service = new PolicyService({ repository, audit });
  return { repository, audit, service };
}
