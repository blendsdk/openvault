import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { PluginDefinition } from "blendsdk/webafx";
import { NotFoundError, staticFilesPlugin } from "blendsdk/webafx";
import type { PinoLoggerProvider } from "blendsdk/webafx-pino";
import { createLoggerPlugin } from "blendsdk/webafx-pino";
import type { AgentAuthenticator } from "./agent/agent-authenticator.js";
import { agentAuthMiddleware } from "./agent/agent-middleware.js";
import { ConsumerRepository } from "./agent/consumer-repository.js";
import { AgentConsumerService } from "./agent/consumer-service.js";
import type { AgentProjectResolver } from "./agent/project-resolver.js";
import { createAuditCore, createAuditRuntime } from "./audit/runtime.js";
import { createAuthPlugin } from "./auth/plugin.js";
import { CertificateExpiryRepository } from "./certificates/expiry/repository.js";
import { CertificateExpiryScheduler } from "./certificates/expiry/scheduler.js";
import { CertificateExpiryService } from "./certificates/expiry/service.js";
import { CertificateExpiryWebhook } from "./certificates/expiry/webhook.js";
import { createCertificateRuntime } from "./certificates/runtime.js";
import type { OpenVaultConfig } from "./config/index.js";
import { AgentController } from "./controllers/agent.js";
import { AccessExplainController, AssignmentsController } from "./controllers/assignments.js";
import { AuditController } from "./controllers/audit.js";
import { AuthController } from "./controllers/auth.js";
import { CertificatesController } from "./controllers/certificates.js";
import { CliAuthController } from "./controllers/cli-auth.js";
import { IdentityController } from "./controllers/identity.js";
import { MetaController } from "./controllers/meta.js";
import { OidcController } from "./controllers/oidc.js";
import { ProjectsController } from "./controllers/projects.js";
import { ReadyController } from "./controllers/ready.js";
import { ScaffoldController } from "./controllers/scaffold.js";
import { SecretsController } from "./controllers/secrets.js";
import { createIdentityRuntime } from "./identity/identity-runtime.js";
import { createLoggerProvider } from "./observability/logger.js";
import { ProjectRepository } from "./projects/repository.js";
import { ProjectService } from "./projects/service.js";
import { VaultPurger } from "./purge/vault-purger.js";
import { createPolicyRuntime } from "./rbac/runtime.js";
import { createProductionProbes, ReadinessService } from "./readiness/service.js";
import { ScaffoldService } from "./scaffold/service.js";
import { createSecretRuntime } from "./secrets/runtime.js";
import { KeyringProvider } from "./security/keyring.js";
import { installPreStack, type PreStackOptions } from "./transport/pre-stack.js";
import {
  type SecureApplicationDependencies,
  SecureWebApplication,
} from "./transport/secure-application.js";

/** Resolves the built web UI root, honoring an explicit deployment override. */
function resolveWebRoot(): string {
  const override = process.env.OPENVAULT_WEB_ROOT;
  return override === undefined || override.length === 0
    ? fileURLToPath(new URL("../../web/dist", import.meta.url))
    : resolve(override);
}

/**
 * Keeps unknown API routes JSON even when the client accepts HTML.
 *
 * The static plugin's SPA fallback is intentionally broad; this terminal
 * plugin runs before it (lower priority) and sends every unmatched `/v1`
 * request to the normal error envelope instead of `index.html`.
 */
function apiNotFoundPlugin(): PluginDefinition {
  return {
    name: "openvault-api-404",
    priority: 19,
    factory: async () => ({
      terminal: async ({ express }) => {
        express.use("/v1", (_req, _res, next) => {
          next(new NotFoundError("Not Found"));
        });
      },
    }),
  };
}

/** Adds the browser UI when a complete build is present. */
function installWebUi(app: SecureWebApplication, webRoot: string): { readonly enabled: boolean } {
  if (!existsSync(join(webRoot, "index.html")) || !existsSync(join(webRoot, "assets"))) {
    return { enabled: false };
  }
  app.use(
    staticFilesPlugin({
      root: join(webRoot, "assets"),
      prefix: "/assets",
      maxAge: "1y",
      immutable: true,
      index: false,
    }),
  );
  app.use(apiNotFoundPlugin());
  app.use(staticFilesPlugin({ root: webRoot, spa: true, maxAge: 0 }));
  return { enabled: true };
}

/**
 * Builds the production application with validated configuration and runtime
 * dependencies.
 *
 * The pre-stack is installed before WebAFX initialization so security-boundary
 * rejections never reach a controller. WebAFX remains the only response
 * envelope renderer.
 *
 * @param config - Validated runtime configuration.
 * @param dependencies - Database, TLS material, and keyring provider.
 * @returns An application that must be prepared and bound with `startTransport`.
 */
export function createApplication(
  config: OpenVaultConfig,
  dependencies: SecureApplicationDependencies,
  options: PreStackOptions = {},
): SecureWebApplication {
  if (dependencies.agentRuntime !== undefined && dependencies.identityRuntime !== undefined) {
    throw new Error("Provide either an agent runtime or an identity runtime, not both");
  }
  const app = new SecureWebApplication(config, dependencies);
  const provider: PinoLoggerProvider =
    dependencies.logger ?? createLoggerProvider(config, dependencies.loggerDestination);
  const auditDatabase =
    dependencies.auditRuntime === undefined && dependencies.agentRuntime?.auditRuntime === undefined
      ? new PostgreSQLDatabase({
          ...config.database,
          poolConfig: { max: 1, idleTimeoutMillis: 100 },
          enableGracefulShutdown: false,
        })
      : undefined;
  let auditCore: ReturnType<typeof createAuditCore> | undefined =
    dependencies.auditRuntime ?? dependencies.agentRuntime?.auditRuntime;
  const policyRuntime =
    dependencies.agentRuntime?.policyRuntime ??
    dependencies.identityRuntime?.policyRuntime ??
    (() => {
      auditCore ??= createAuditCore({
        database: dependencies.database,
        ...(auditDatabase === undefined ? {} : { independentDatabase: auditDatabase }),
        keyring: dependencies.keyring,
      });
      return createPolicyRuntime({
        database: dependencies.database,
        logger: provider,
        audit: auditCore.policyAudit,
      });
    })();
  if (auditCore === undefined) {
    auditCore = createAuditCore({
      database: dependencies.database,
      ...(auditDatabase === undefined ? {} : { independentDatabase: auditDatabase }),
      keyring: dependencies.keyring,
    });
  }
  const auditRuntime =
    dependencies.auditRuntime ??
    dependencies.agentRuntime?.auditRuntime ??
    createAuditRuntime({
      core: auditCore,
      policy: policyRuntime.service,
      database: dependencies.database,
      keyring: dependencies.keyring,
    });
  const projectRepository = new ProjectRepository(dependencies.database);
  const projectService = new ProjectService({
    database: dependencies.database,
    repository: projectRepository,
    policy: policyRuntime.service,
    audit: auditRuntime.writer,
  });
  const vaultPurger = new VaultPurger({
    ...(config.purgeDatabaseUrl === undefined ? {} : { url: config.purgeDatabaseUrl }),
    appDatabase: config.database.database ?? "",
  });
  const secretRuntime = createSecretRuntime({
    database: dependencies.database,
    keyring: dependencies.keyring,
    policy: policyRuntime.service,
    audit: auditRuntime.writer,
    projectRepository,
    secretMaxBytes: config.secretMaxBytes,
    softDeleteDays: config.softDeleteDays,
    purger: vaultPurger,
  });

  const agentConsumerService = new AgentConsumerService({
    database: dependencies.database,
    consumers: new ConsumerRepository(dependencies.database),
    audit: auditRuntime.service,
    logger: provider,
  });
  const certificateRuntime = createCertificateRuntime({
    database: dependencies.database,
    keyring: dependencies.keyring,
    policy: policyRuntime.service,
    audit: auditRuntime.writer,
    projectRepository,
    certMaxBytes: config.certMaxBytes,
    softDeleteDays: config.softDeleteDays,
    purger: vaultPurger,
  });

  const certificateExpiryWebhook =
    config.certExpiryWebhookUrl === undefined
      ? undefined
      : new CertificateExpiryWebhook({
          url: new URL(config.certExpiryWebhookUrl),
          ...(config.certExpiryWebhookSecret === undefined
            ? {}
            : { secret: config.certExpiryWebhookSecret }),
        });
  const certificateExpiryService = new CertificateExpiryService({
    database: dependencies.database,
    repository: new CertificateExpiryRepository(),
    ...(certificateExpiryWebhook === undefined ? {} : { webhook: certificateExpiryWebhook }),
    audit: auditRuntime.writer,
    logger: provider,
  });
  const certificateExpiryScheduler = new CertificateExpiryScheduler({
    service: certificateExpiryService,
    hour: config.certExpiryHour,
    logger: provider,
  });
  const identityRuntime =
    dependencies.agentRuntime?.identityRuntime ??
    dependencies.identityRuntime ??
    createIdentityRuntime({
      database: dependencies.database,
      config,
      policyRuntime,
    });
  const scaffoldService = new ScaffoldService({
    database: dependencies.database,
    projects: projectService,
    projectRepository,
    identities: identityRuntime.service,
    assignments: policyRuntime.assignments,
    secrets: secretRuntime.repository,
    policy: policyRuntime.service,
    policyRepository: policyRuntime.repository,
  });

  const authenticator =
    dependencies.agentRuntime?.authenticator ?? dependencies.agentOverrides?.authenticator;
  const projectResolver: AgentProjectResolver = dependencies.agentRuntime?.projectResolver ??
    dependencies.agentOverrides?.projectResolver ?? {
      resolveActiveByName: async () => undefined,
    };

  const webRoot = resolveWebRoot();
  const webUi = installWebUi(app, webRoot);
  installPreStack(app.express, config, provider, { ...options, webUiEnabled: webUi.enabled });
  if (authenticator !== undefined) {
    app.express.use(agentAuthMiddleware(authenticator, projectResolver));
  }

  app.registerService({
    name: "config",
    type: "singleton",
    factory: () => config,
  });
  app.registerService({
    name: "database",
    type: "singleton",
    factory: () => dependencies.database,
    dispose: async (database) => {
      if (database instanceof PostgreSQLDatabase) {
        await database.disconnect();
      }
    },
  });
  if (auditDatabase !== undefined) {
    app.registerService({
      name: "auditDatabase",
      type: "singleton",
      factory: () => auditDatabase,
      dispose: async (database) => {
        if (database instanceof PostgreSQLDatabase) {
          await database.disconnect();
        }
      },
    });
  }
  app.registerService({
    name: "keyring",
    type: "singleton",
    factory: () => dependencies.keyring,
    dispose: (keyring) => {
      if (keyring instanceof KeyringProvider) {
        keyring.destroy();
      }
    },
  });
  app.registerService({
    name: "policyRepository",
    type: "singleton",
    factory: () => policyRuntime.repository,
  });
  app.registerService({
    name: "policyAudit",
    type: "singleton",
    factory: () => policyRuntime.audit,
  });
  app.registerService({
    name: "policyService",
    type: "singleton",
    factory: () => policyRuntime.service,
  });
  app.registerService({
    name: "assignmentService",
    type: "singleton",
    factory: () => policyRuntime.assignments,
  });
  app.registerService({
    name: "rbacRateLimits",
    type: "singleton",
    factory: () => policyRuntime.rateLimits,
  });
  app.registerService({
    name: "auditService",
    type: "singleton",
    factory: () => auditRuntime.service,
  });
  app.registerService({
    name: "auditRateLimits",
    type: "singleton",
    factory: () => auditRuntime.rateLimits,
  });
  app.registerService({
    name: "auditRuntime",
    type: "singleton",
    factory: () => auditRuntime,
  });
  app.registerService({
    name: "projectRepository",
    type: "singleton",
    factory: () => projectRepository,
  });
  app.registerService({
    name: "projectService",
    type: "singleton",
    factory: () => projectService,
  });
  app.registerService({
    name: "agentConsumerService",
    type: "singleton",
    factory: () => agentConsumerService,
  });
  app.registerService({
    name: "scaffoldService",
    type: "singleton",
    factory: () => scaffoldService,
  });
  app.registerService({
    name: "secretRepository",
    type: "singleton",
    factory: () => secretRuntime.repository,
  });
  app.registerService({
    name: "secretService",
    type: "singleton",
    factory: () => secretRuntime.service,
  });
  app.registerService({
    name: "secretRateLimits",
    type: "singleton",
    factory: () => secretRuntime.rateLimits,
  });
  app.registerService({
    name: "vaultPurger",
    type: "singleton",
    factory: () => vaultPurger,
    dispose: async (value: unknown) => {
      if (value instanceof VaultPurger) {
        await value.close();
      }
    },
  });
  app.registerService({
    name: "certificateRepository",
    type: "singleton",
    factory: () => certificateRuntime.repository,
  });
  app.registerService({
    name: "certificateService",
    type: "singleton",
    factory: () => certificateRuntime.service,
  });
  app.registerService({
    name: "certificateLifecycle",
    type: "singleton",
    factory: () => certificateRuntime.lifecycle,
  });
  app.registerService({
    name: "certificateRateLimits",
    type: "singleton",
    factory: () => certificateRuntime.rateLimits,
  });
  app.registerService({
    name: "certificateExpiryService",
    type: "singleton",
    factory: () => certificateExpiryService,
  });
  app.registerService({
    name: "certificateExpiryScheduler",
    type: "singleton",
    factory: () => certificateExpiryScheduler,
    dispose: async (value: unknown) => {
      if (value instanceof CertificateExpiryScheduler) {
        await value.stop();
      }
    },
  });
  app.registerService({
    name: "identityRuntime",
    type: "singleton",
    factory: () => identityRuntime,
  });
  app.registerService({
    name: "identityRepository",
    type: "singleton",
    factory: () => identityRuntime.repository,
  });
  app.registerService({
    name: "identityAuthorizer",
    type: "singleton",
    factory: () => identityRuntime.authorizer,
  });
  app.registerService({
    name: "identityService",
    type: "singleton",
    factory: () => identityRuntime.service,
  });
  app.registerService({
    name: "agentTokenService",
    type: "singleton",
    factory: () => identityRuntime.tokens,
  });
  if (dependencies.agentRuntime !== undefined) {
    const runtime = dependencies.agentRuntime;
    app.registerService({
      name: "agentRuntime",
      type: "singleton",
      factory: () => runtime,
      dispose: () => runtime.dispose(),
    });
    app.registerService({
      name: "caSigner",
      type: "singleton",
      factory: () => runtime.caSigner,
    });
    app.registerService({
      name: "agentAuthenticator",
      type: "singleton",
      factory: () => runtime.authenticator,
    });
    app.registerService({
      name: "agentProjectResolver",
      type: "singleton",
      factory: () => runtime.projectResolver,
    });
    app.registerService({
      name: "agentJoinService",
      type: "singleton",
      factory: () => runtime.joinService,
    });
    app.registerService({
      name: "agentRenewService",
      type: "singleton",
      factory: () => runtime.renewService,
    });
    app.registerService({
      name: "agentRateLimits",
      type: "singleton",
      factory: () => runtime.rateLimits,
    });
    app.registerService({
      name: "renewalReplayCache",
      type: "singleton",
      factory: () => runtime.renewalCache,
    });
  }
  app.registerService({
    name: "readiness",
    type: "singleton",
    factory: () =>
      new ReadinessService(
        dependencies.readinessProbes ??
          createProductionProbes({
            database: dependencies.database,
            keyring: dependencies.keyring,
            tls: dependencies.tls,
            ...(dependencies.agentRuntime === undefined
              ? {}
              : { caSigner: dependencies.agentRuntime.caSigner }),
          }),
      ),
  });
  app.use(
    createAuthPlugin({
      config,
      database: dependencies.database,
      keyring: dependencies.keyring,
      logger: provider,
      ...(dependencies.authOverrides === undefined
        ? {}
        : { overrides: dependencies.authOverrides }),
    }),
  );
  app.registerController("", ReadyController);
  app.registerController("/v1/auth", AuthController);
  app.registerController("/v1/auth/cli", CliAuthController);
  app.registerController("/v1/auth", OidcController);
  app.registerController("/v1/admin/projects", ProjectsController);
  app.registerController("/v1/data", SecretsController);
  app.registerController("/v1/data", CertificatesController);
  app.registerController("/v1/admin/identities", IdentityController);
  app.registerController("/v1/admin/scaffold", ScaffoldController);
  app.registerController("/v1/admin/assignments", AssignmentsController);
  app.registerController("/v1/admin/access-explain", AccessExplainController);
  app.registerController("/v1/audit", AuditController);
  if (dependencies.agentRuntime !== undefined) {
    app.registerController("/v1/agent", AgentController);
  }
  app.registerController("/v1/meta", MetaController);

  if (dependencies.disableBackgroundJobs !== true) {
    void certificateExpiryScheduler.start();
  }
  app.use(createLoggerPlugin(provider));

  return app;
}

/**
 * Builds a prepared application for in-process tests.
 *
 * The application uses the same WebAFX assembly as production but does not
 * bind a listener. Tests read `app.express` through supertest or call
 * `startTransport` when they need real HTTPS sockets.
 *
 * @param config - Validated runtime configuration.
 * @param dependencies - Test dependencies, including fake readiness probes.
 * @returns A prepared application.
 */
export async function createTestApplication(
  config: OpenVaultConfig,
  dependencies: SecureApplicationDependencies,
): Promise<SecureWebApplication> {
  const authenticator: AgentAuthenticator = dependencies.agentRuntime?.authenticator ??
    dependencies.agentOverrides?.authenticator ?? {
      authenticate: async () => undefined,
      revalidate: async () => undefined,
      invalidatePrincipal: () => undefined,
    };
  const projectResolver: AgentProjectResolver = dependencies.agentRuntime?.projectResolver ??
    dependencies.agentOverrides?.projectResolver ?? {
      resolveActiveByName: async () => undefined,
    };
  const app = createApplication(
    config,
    {
      ...dependencies,
      disableBackgroundJobs: true,
      agentOverrides: { ...dependencies.agentOverrides, authenticator, projectResolver },
    },
    { testListener: "admin" },
  );
  await app.prepare();
  return app;
}
