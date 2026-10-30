import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { KeyringProvider } from "../security/keyring.js";
import type { TlsMaterial } from "../transport/tls.js";

/** Dependency probe that contributes to readiness. */
export type ReadinessProbeName = "postgresql" | "keyring" | "tls" | "audit";

/** Failure name, including the overall timeout sentinel. */
export type ReadinessFailure = ReadinessProbeName | "timeout";

/** One dependency check used by the readiness service. */
export interface ReadinessProbe {
  readonly name: ReadinessProbeName;
  check(): Promise<void>;
}

/** Raised when a readiness probe fails. The message contains no secret data. */
export class ReadinessError extends Error {
  /** Fixed probe name that failed, or `timeout` for the whole operation. */
  public readonly probe: ReadinessFailure;

  public constructor(probe: ReadinessFailure) {
    super(`Readiness probe failed: ${probe}`);
    this.name = "ReadinessError";
    this.probe = probe;
  }
}

/**
 * Runs the dependency probes behind one bounded timeout.
 *
 * Probes run in parallel. A failure is reported as {@link ReadinessError}; a
 * probe that never settles is cut off by the timeout so a request cannot hang.
 */
export class ReadinessService {
  readonly #probes: readonly ReadinessProbe[];
  readonly #timeoutMs: number;

  public constructor(probes: readonly ReadinessProbe[], timeoutMs = 2_000) {
    this.#probes = probes;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Resolves when every probe succeeds.
   *
   * @throws {ReadinessError} When a probe fails or the timeout expires.
   */
  public async check(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ReadinessError("timeout"));
      }, this.#timeoutMs);
    });

    try {
      await Promise.race([Promise.all(this.#probes.map((probe) => probe.check())), timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

/** Builds the production probes from the runtime dependencies. */
export function createProductionProbes(dependencies: {
  readonly database: PostgreSQLDatabase;
  readonly keyring: KeyringProvider;
  readonly tls: TlsMaterial;
}): readonly ReadinessProbe[] {
  return [
    {
      name: "postgresql",
      async check(): Promise<void> {
        try {
          await dependencies.database.executeQuery("SELECT 1");
        } catch {
          throw new ReadinessError("postgresql");
        }
      },
    },
    {
      name: "keyring",
      async check(): Promise<void> {
        const status = dependencies.keyring.status();
        if (!status.loaded || status.currentId === undefined) {
          throw new ReadinessError("keyring");
        }
      },
    },
    {
      name: "tls",
      async check(): Promise<void> {
        try {
          dependencies.tls.checkReady();
        } catch {
          throw new ReadinessError("tls");
        }
      },
    },
    {
      name: "audit",
      async check(): Promise<void> {
        try {
          await dependencies.database.executeQuery("SELECT 1 FROM audit_events LIMIT 1");
        } catch {
          throw new ReadinessError("audit");
        }
      },
    },
  ];
}
