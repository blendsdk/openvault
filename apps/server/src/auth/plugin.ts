import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { PluginDefinition } from "blendsdk/webafx";
import { MemoryCacheProvider } from "blendsdk/webafx-cache/memory";
import type { OpenVaultConfig } from "../config/index.js";
import { CredentialsRepository } from "./credentials.js";
import { csrfGuard, originGuard } from "./csrf.js";
import { passwordChangeGate, sessionMiddleware } from "./middleware.js";
import { SessionService } from "./sessions.js";

/** Options required to install the authentication boundary. */
export interface AuthPluginOptions {
  /** Validated runtime configuration. */
  readonly config: OpenVaultConfig;
  /** Connected PostgreSQL database. */
  readonly database: PostgreSQLDatabase;
}

/**
 * Builds the WebAFX plugin that owns the session service and auth middleware.
 *
 * The plugin installs after WebAFX core middleware (so cookies and JSON bodies
 * are parsed) and before controllers. It registers the `sessions` and
 * `credentials` services and wires session resolution, the forced-change gate,
 * the origin guard, and the session-scoped CSRF check.
 *
 * @param options - Configuration and database dependencies.
 * @returns A WebAFX plugin definition.
 */
export function createAuthPlugin(options: AuthPluginOptions): PluginDefinition {
  return {
    name: "openvault-auth",
    priority: 15,
    factory: async ({ app, express }) => {
      const cache = new MemoryCacheProvider({
        rootKey: "openvault",
        serviceName: "sessions",
        cleanupIntervalMs: 60_000,
      });
      const sessions = new SessionService({ config: options.config, cache });
      const credentials = new CredentialsRepository(options.database);

      app.registerService({
        name: "sessions",
        type: "singleton",
        factory: () => sessions,
        dispose: () => sessions.destroy(),
      });
      app.registerService({
        name: "credentials",
        type: "singleton",
        factory: () => credentials,
      });

      express.use(sessionMiddleware(sessions, credentials));
      express.use(passwordChangeGate());
      express.use(originGuard(options.config));
      express.use(csrfGuard(sessions));
    },
  };
}
