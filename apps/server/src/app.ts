import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { createLoggerPlugin } from "blendsdk/webafx-pino";
import type { OpenVaultConfig } from "./config/index.js";
import { ReadyController } from "./controllers/ready.js";
import { createLoggerProvider } from "./observability/logger.js";
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
    name: "tls",
    type: "singleton",
    factory: () => dependencies.tls,
  });

  app.registerController("", ReadyController);
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
