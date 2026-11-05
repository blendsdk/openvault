import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { AuditWriter } from "../audit/audit-writer.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { VaultPurger } from "../purge/vault-purger.js";
import type { PolicyService } from "../rbac/policy-service.js";
import type { KeyringProvider } from "../security/keyring.js";
import {
  createSecretRateLimitService,
  type SecretRateLimitOptions,
  type SecretRateLimitService,
} from "./rate-limits.js";
import { SecretRepository } from "./repository.js";
import { SecretService } from "./service.js";

/** Secret persistence, service, and limiter. */
export interface SecretRuntime {
  /** Secret persistence. */
  readonly repository: SecretRepository;
  /** Data-plane service. */
  readonly service: SecretService;
  /** `/v1/data` limiter. */
  readonly rateLimits: SecretRateLimitService;
}

/**
 * Builds the secret data-plane runtime.
 *
 * @param options - Database, keyring, policy, audit, projects, and limits.
 * @returns The composed runtime.
 */
export function createSecretRuntime(options: {
  readonly database: PostgreSQLDatabase;
  readonly keyring: KeyringProvider;
  readonly policy: PolicyService;
  readonly audit: AuditWriter;
  readonly projectRepository: ProjectRepository;
  readonly secretMaxBytes: number;
  readonly softDeleteDays: number;
  readonly purger?: VaultPurger;
  readonly now?: () => number;
  readonly rateLimitOptions?: SecretRateLimitOptions;
}): SecretRuntime {
  const repository = new SecretRepository();
  const service = new SecretService({
    database: options.database,
    keyring: options.keyring,
    policy: options.policy,
    audit: options.audit,
    projectRepository: options.projectRepository,
    repository,
    secretMaxBytes: options.secretMaxBytes,
    softDeleteDays: options.softDeleteDays,
    ...(options.purger === undefined ? {} : { purger: options.purger }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const rateLimits = createSecretRateLimitService(options.rateLimitOptions);
  return { repository, service, rateLimits };
}
