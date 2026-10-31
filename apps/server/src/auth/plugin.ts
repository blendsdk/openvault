import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { PluginDefinition } from "blendsdk/webafx";
import type { CacheProvider } from "blendsdk/webafx-cache";
import { MemoryCacheProvider } from "blendsdk/webafx-cache/memory";
import type { OpenVaultConfig } from "../config/index.js";
import { CredentialsRepository } from "./credentials.js";
import { csrfGuard, originGuard } from "./csrf.js";
import { passwordChangeGate, sessionMiddleware } from "./middleware.js";
import { OidcClient } from "./oidc/client.js";
import { OidcIdentityService } from "./oidc/identity.js";
import { OidcStateStore } from "./oidc/state.js";
import { SessionService } from "./sessions.js";
import type { AuthOverrides } from "./types.js";

/** Options required to install the authentication boundary. */
export interface AuthPluginOptions {
  /** Validated runtime configuration. */
  readonly config: OpenVaultConfig;
  /** Connected PostgreSQL database. */
  readonly database: PostgreSQLDatabase;
  /** Test-only collaboration seams. Production leaves this empty. */
  readonly overrides?: AuthOverrides;
}

/**
 * Builds the WebAFX plugin that owns the session service and auth middleware.
 *
 * The plugin installs after WebAFX core middleware (so cookies and JSON bodies
 * are parsed) and before controllers. It registers the session, credential,
 * and optional OIDC services and wires session resolution, the forced-change
 * gate, the origin guard, and the session-scoped CSRF check.
 *
 * @param options - Configuration, database, and test overrides.
 * @returns A WebAFX plugin definition.
 */
export function createAuthPlugin(options: AuthPluginOptions): PluginDefinition {
  return {
    name: "openvault-auth",
    priority: 15,
    factory: async ({ app, express }) => {
      const cache: CacheProvider =
        options.overrides?.cache ??
        new MemoryCacheProvider({
          rootKey: "openvault",
          serviceName: "sessions",
          cleanupIntervalMs: 60_000,
        });
      const sessions = new SessionService({
        config: options.config,
        cache,
        ...(options.overrides?.now === undefined ? {} : { now: options.overrides.now }),
        ...(options.overrides?.sweepIntervalMs === undefined
          ? {}
          : { sweepIntervalMs: options.overrides.sweepIntervalMs }),
      });
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

      const oidcConfig = options.config.oidc;
      if (oidcConfig !== undefined) {
        const oidc = new OidcClient({
          config: oidcConfig,
          ...(options.overrides?.fetch === undefined ? {} : { fetch: options.overrides.fetch }),
          ...(options.overrides?.now === undefined ? {} : { now: options.overrides.now }),
        });
        const oidcState = new OidcStateStore({ cache });
        const oidcIdentities = new OidcIdentityService({ database: options.database });

        app.registerService({
          name: "oidc",
          type: "singleton",
          factory: () => oidc,
          dispose: () => oidc.shutdown(),
        });
        app.registerService({
          name: "oidcState",
          type: "singleton",
          factory: () => oidcState,
          dispose: () => oidcState.destroy(),
        });
        app.registerService({
          name: "oidcIdentities",
          type: "singleton",
          factory: () => oidcIdentities,
        });
      }

      express.use(sessionMiddleware(sessions, credentials));
      express.use(passwordChangeGate());
      express.use(originGuard(options.config));
      express.use(csrfGuard(sessions));
    },
  };
}
