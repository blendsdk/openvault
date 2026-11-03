import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import { AgentTokenService } from "../agent/agent-token-service.js";
import type { OpenVaultConfig } from "../config/index.js";
import { IdentityAuthorizer } from "./identity-authorizer.js";
import { IdentityRepository } from "./identity-repository.js";
import { IdentityService } from "./identity-service.js";

/** The single owner of identity repositories and the admin service. */
export interface IdentityRuntime {
  /** Identity persistence. */
  readonly repository: IdentityRepository;
  /** Narrow authorization helper. */
  readonly authorizer: IdentityAuthorizer;
  /** Admin lifecycle service. */
  readonly service: IdentityService;
  /** One-time join-token service. */
  readonly tokens: AgentTokenService;
}

/**
 * Builds the identity runtime used by the admin controller.
 *
 * The optional revocation hook lets the later agent runtime invalidate its
 * request caches without coupling the identity repository to the listener.
 *
 * @param options - Database, configuration, and optional revoke hook.
 * @returns The composed identity runtime.
 */
export function createIdentityRuntime(options: {
  readonly database: PostgreSQLDatabase;
  readonly config: OpenVaultConfig;
  readonly onRevoked?: (principalId: string) => void;
}): IdentityRuntime {
  const repository = new IdentityRepository(options.database);
  const authorizer = new IdentityAuthorizer(options.database);
  const tokens = new AgentTokenService({ database: options.database, config: options.config });
  const service = new IdentityService({
    repository,
    authorizer,
    tokens,
    database: options.database,
    ...(options.onRevoked === undefined ? {} : { onRevoked: options.onRevoked }),
  });
  return { repository, authorizer, service, tokens };
}
