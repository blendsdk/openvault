import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { PluginDefinition } from "blendsdk/webafx";
import type { CacheProvider } from "blendsdk/webafx-cache";
import { MemoryCacheProvider } from "blendsdk/webafx-cache/memory";
import type { OpenVaultConfig } from "../config/index.js";
import type { KeyringProvider } from "../security/keyring.js";
import { SigningKeyRepository, SigningKeyService } from "../security/signing-keys.js";
import { CliAuthService } from "./cli-auth-service.js";
import { CliSessionRepository } from "./cli-sessions.js";
import { CredentialsRepository } from "./credentials.js";
import { csrfGuard, originGuard } from "./csrf.js";
import { LocalLoginService } from "./local-login.js";
import { createAuthRateLimitService } from "./login-rate-limits.js";
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
  /** Loaded KEK provider used by the JWT signer. */
  readonly keyring: KeyringProvider;
  /** Test-only collaboration seams. Production leaves this empty. */
  readonly overrides?: AuthOverrides;
}

/**
 * Builds the WebAFX plugin that owns the session service and auth middleware.
 *
 * The plugin installs after WebAFX core middleware (so cookies and JSON bodies
 * are parsed) and before controllers. It registers session, credential, local
 * login, shared rate-limit, CLI session, signing-key, CLI auth, and optional
 * OIDC services, then wires session resolution, the forced-change gate, the
 * origin guard, and the session-scoped CSRF check.
 *
 * @param options - Configuration, database, keyring, and test overrides.
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
      const localLogin = new LocalLoginService({ credentials });
      const authRateLimits = createAuthRateLimitService();
      const cliSessions = new CliSessionRepository(options.database);
      const signingKeys = new SigningKeyService({
        repository: new SigningKeyRepository(options.database),
        keyring: options.keyring,
        ...(options.overrides?.now === undefined ? {} : { now: options.overrides.now }),
      });
      const cliAuth = new CliAuthService({ sessions: cliSessions, signingKeys });

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
      app.registerService({
        name: "localLogin",
        type: "singleton",
        factory: () => localLogin,
      });
      app.registerService({
        name: "authRateLimits",
        type: "singleton",
        factory: () => authRateLimits,
      });
      app.registerService({
        name: "cliSessions",
        type: "singleton",
        factory: () => cliSessions,
      });
      app.registerService({
        name: "signingKeys",
        type: "singleton",
        factory: () => signingKeys,
        dispose: () => signingKeys.destroy(),
      });
      app.registerService({
        name: "cliAuth",
        type: "singleton",
        factory: () => cliAuth,
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
