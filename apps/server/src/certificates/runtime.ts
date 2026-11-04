import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { AuditWriter } from "../audit/audit-writer.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { PolicyService } from "../rbac/policy-service.js";
import type { KeyringProvider } from "../security/keyring.js";
import { CertificateLifecycle, type CertificatePurgePort } from "./lifecycle.js";
import {
  type CertificateRateLimitOptions,
  type CertificateRateLimitService,
  createCertificateRateLimitService,
} from "./rate-limits.js";
import { CertificateRepository } from "./repository.js";
import { CertificateService } from "./service.js";

/** Certificate persistence, services, and limiters. */
export interface CertificateRuntime {
  /** Certificate persistence. */
  readonly repository: CertificateRepository;
  /** Write/read service. */
  readonly service: CertificateService;
  /** Lifecycle service. */
  readonly lifecycle: CertificateLifecycle;
  /** Certificate limiters. */
  readonly rateLimits: CertificateRateLimitService;
}

/**
 * Builds the certificate data-plane runtime.
 *
 * @param options - Database, keyring, policy, audit, projects, limits, and purger.
 * @returns The composed runtime.
 */
export function createCertificateRuntime(options: {
  readonly database: PostgreSQLDatabase;
  readonly keyring: KeyringProvider;
  readonly policy: PolicyService;
  readonly audit: AuditWriter;
  readonly projectRepository: ProjectRepository;
  readonly certMaxBytes: number;
  readonly softDeleteDays: number;
  readonly purger?: CertificatePurgePort;
  readonly now?: () => number;
  readonly rateLimitOptions?: CertificateRateLimitOptions;
}): CertificateRuntime {
  const repository = new CertificateRepository();
  const service = new CertificateService({
    database: options.database,
    keyring: options.keyring,
    policy: options.policy,
    audit: options.audit,
    projectRepository: options.projectRepository,
    repository,
    certMaxBytes: options.certMaxBytes,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const lifecycle = new CertificateLifecycle({
    database: options.database,
    repository,
    service,
    projectRepository: options.projectRepository,
    policy: options.policy,
    audit: options.audit,
    softDeleteDays: options.softDeleteDays,
    ...(options.purger === undefined ? {} : { purger: options.purger }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const rateLimits = createCertificateRateLimitService(options.rateLimitOptions);
  return { repository, service, lifecycle, rateLimits };
}
