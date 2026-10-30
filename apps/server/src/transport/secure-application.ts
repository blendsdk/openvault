import { createServer, type Server, type ServerOptions } from "node:https";
import type { Writable } from "node:stream";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import { WebApplication } from "blendsdk/webafx";
import { createWebApplicationConfig, type OpenVaultConfig } from "../config/index.js";
import type { KeyringProvider } from "../security/keyring.js";
import { CidrMatcher, createTrustProxy } from "./proxy.js";
import { type ListenerKind, markListener } from "./scope.js";
import type { TlsMaterial } from "./tls.js";

/** Options for binding the two HTTPS listeners. */
export interface StartTransportOptions {
  /** Test override; `0` asks the operating system for an ephemeral port. */
  readonly adminPort?: number;
  /** Test override; `0` asks the operating system for an ephemeral port. */
  readonly agentPort?: number;
}

/** A running secure transport. */
export interface TransportHandle {
  /** Bound admin port. */
  readonly adminPort: number;
  /** Bound agent port. */
  readonly agentPort: number;
  /** Bound admin server; exposed for lifecycle assertions. */
  readonly adminServer: Server;
  /** Bound agent server; exposed for lifecycle assertions. */
  readonly agentServer: Server;
  /** Idempotent shutdown for both listeners and owned services. */
  readonly stop: () => Promise<void>;
}

/** Runtime dependencies supplied by the process entry point or a test. */
export interface SecureApplicationDependencies {
  readonly database: PostgreSQLDatabase;
  readonly tls: TlsMaterial;
  readonly keyring: KeyringProvider;
  /** Test-only pino destination for captured structured logs. */
  readonly loggerDestination?: Writable;
}

/** Timeouts and connection caps applied to each HTTPS server. */
export const TRANSPORT_SETTINGS = {
  admin: {
    headersTimeout: 10_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 15_000,
    maxConnections: 1_024,
  },
  agent: {
    headersTimeout: 10_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 15_000,
    maxConnections: 512,
  },
} as const;

const SHUTDOWN_TIMEOUT_MS = 10_000;

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", onError);
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("HTTPS listener did not expose a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      server.closeIdleConnections();
      server.closeAllConnections();
    }, SHUTDOWN_TIMEOUT_MS);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function applySettings(server: Server, listener: ListenerKind): void {
  const settings = TRANSPORT_SETTINGS[listener];
  server.headersTimeout = settings.headersTimeout;
  server.requestTimeout = settings.requestTimeout;
  server.keepAliveTimeout = settings.keepAliveTimeout;
  server.maxConnections = settings.maxConnections;
}

/**
 * WebAFX application with an HTTPS-only, two-listener lifecycle.
 *
 * WebAFX still owns routing, dependency injection, plugins, envelopes,
 * liveness, and service disposal. This adapter owns exactly two Node HTTPS
 * servers and one idempotent shutdown. The plaintext `start()` path is disabled.
 */
export class SecureWebApplication extends WebApplication {
  readonly #config: OpenVaultConfig;
  readonly #dependencies: SecureApplicationDependencies;
  #prepared = false;
  #servers: { readonly admin: Server; readonly agent: Server } | undefined;
  #transport: TransportHandle | undefined;
  #stopping: Promise<void> | undefined;
  #stopped = false;

  public constructor(config: OpenVaultConfig, dependencies: SecureApplicationDependencies) {
    super(createWebApplicationConfig(config));
    this.#config = config;
    this.#dependencies = dependencies;
  }

  /** Initializes WebAFX once and installs the validated trust-proxy predicate. */
  public async prepare(): Promise<void> {
    if (this.#prepared) {
      return;
    }
    await this.initialize();
    this.#prepared = true;

    if (this.#config.trustProxy) {
      const matcher = new CidrMatcher(this.#config.proxyCidrs);
      this.express.set("trust proxy", createTrustProxy(matcher));
    }
  }

  /**
   * Binds the admin and agent HTTPS listeners.
   *
   * A second start is rejected. If the agent bind fails, the admin listener is
   * closed and the keyring is destroyed before the error propagates.
   */
  public async startTransport(options: StartTransportOptions = {}): Promise<TransportHandle> {
    if (this.#transport !== undefined || this.#stopped) {
      throw new Error("SecureWebApplication transport is already started or stopped");
    }
    await this.prepare();

    const tls = this.#dependencies.tls;
    const adminOptions: ServerOptions = {
      key: tls.keyPem,
      cert: tls.certPem,
      minVersion: "TLSv1.2",
    };
    const agentOptions: ServerOptions = {
      ...adminOptions,
      requestCert: true,
      rejectUnauthorized: true,
      ca: [tls.caPem],
    };

    const admin = createServer(adminOptions, (req, res) => {
      markListener(req, "admin");
      this.express(req, res);
    });
    const agent = createServer(agentOptions, (req, res) => {
      markListener(req, "agent");
      this.express(req, res);
    });
    applySettings(admin, "admin");
    applySettings(agent, "agent");

    let adminPort: number;
    let agentPort: number;
    try {
      adminPort = await listen(admin, options.adminPort ?? this.#config.adminPort);
      agentPort = await listen(agent, options.agentPort ?? this.#config.agentPort);
    } catch (error) {
      await Promise.all([closeServer(admin), closeServer(agent)]);
      this.#dependencies.keyring.destroy();
      throw error;
    }

    this.#servers = { admin, agent };
    this.started = true;

    try {
      await this.runHooks("afterStart");
    } catch (error) {
      try {
        await this.stop();
      } catch {
        // Preserve the original after-start failure; cleanup already ran best-effort.
      }
      throw error;
    }

    this.setupSignalHandlers(async () => {
      try {
        await this.stop();
      } catch (error) {
        process.stderr.write(
          `Shutdown failed: ${error instanceof Error ? error.name : "unknown"}\n`,
        );
      }
    });

    const handle: TransportHandle = {
      adminPort,
      agentPort,
      adminServer: admin,
      agentServer: agent,
      stop: () => this.stop(),
    };
    this.#transport = handle;
    return handle;
  }

  /** The plaintext starter is never reachable from production code. */
  public override start(): Promise<() => Promise<void>> {
    return Promise.reject(
      new Error("SecureWebApplication requires startTransport(); plaintext start is disabled"),
    );
  }

  /** Stops both listeners, disposes services, and destroys the keyring. */
  public async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    if (this.#stopping !== undefined) {
      await this.#stopping;
      return;
    }
    this.#stopping = this.#stopInternal();
    try {
      await this.#stopping;
    } finally {
      this.#stopping = undefined;
    }
  }

  async #stopInternal(): Promise<void> {
    const servers = this.#servers;
    this.#servers = undefined;
    this.#transport = undefined;
    let disposed = false;

    try {
      if (servers !== undefined) {
        await Promise.all([closeServer(servers.admin), closeServer(servers.agent)]);
      }

      // WebAFX only disposes services when its started flag is set.
      this.started = true;
      await this.shutdown();
      disposed = true;
    } finally {
      this.#dependencies.keyring.destroy();
      this.cleanupSignalHandlers();
      this.started = false;
      // Keep a failed stop retryable while still releasing keys and signals.
      this.#stopped = disposed;
    }
  }

  /** Validated configuration is injected; WebAFX file overrides stay disabled. */
  protected override async loadConfiguration(): Promise<void> {
    // Deliberately empty: `.env.js` and `.env.local.js` must not overwrite validated values.
  }
}
