import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { createLoggerPlugin } from "blendsdk/webafx-pino";
import { createAuthPlugin } from "./auth/plugin.js";
import type { OpenVaultConfig } from "./config/index.js";
import { AuthController } from "./controllers/auth.js";
import { CliAuthController } from "./controllers/cli-auth.js";
import { IdentityController } from "./controllers/identity.js";
import { MetaController } from "./controllers/meta.js";
import { OidcController } from "./controllers/oidc.js";
import { ReadyController } from "./controllers/ready.js";
import { createIdentityRuntime } from "./identity/identity-runtime.js";
import { createLoggerProvider } from "./observability/logger.js";
import { createProductionProbes, ReadinessService } from "./readiness/service.js";
import { KeyringProvider } from "./security/keyring.js";
import { installPreStack, type PreStackOptions } from "./transport/pre-stack.js";
import {
  type SecureApplicationDependencies,
  SecureWebApplication,
} from "./transport/secure-application.js";

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
  const app = new SecureWebApplication(config, dependencies);
  const provider = createLoggerProvider(config, dependencies.loggerDestination);
  const identityRuntime =
    dependencies.identityRuntime ??
    createIdentityRuntime({ database: dependencies.database, config });

  installPreStack(app.express, config, provider, options);

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
  app.registerService({
    name: "readiness",
    type: "singleton",
    factory: () =>
      new ReadinessService(dependencies.readinessProbes ?? createProductionProbes(dependencies)),
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
  app.registerController("/v1/admin/identities", IdentityController);
  app.registerController("/v1/meta", MetaController);
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
  const app = createApplication(config, dependencies, { testListener: "admin" });
  await app.prepare();
  return app;
}
