import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { parseDatabaseUrl } from "../db/url.js";
import { KeyringProvider } from "../security/keyring.js";

/** Result of one local operations probe. */
export interface OperationsProbe {
  /** True when the dependency answered. */
  readonly ok: boolean;
  /** Short, value-free explanation. */
  readonly detail: string;
}

/**
 * Checks that the database URL accepts a simple query.
 *
 * The URL and driver error are never returned. A failure means the operator
 * should inspect `OPENVAULT_DB_URL` or the database health, not that the CLI
 * should print a credential-bearing connection string.
 *
 * @param databaseUrl - PostgreSQL URL to probe.
 * @returns Probe status.
 */
export async function probeDatabase(databaseUrl: string): Promise<OperationsProbe> {
  let database: PostgreSQLDatabase | undefined;
  try {
    database = new PostgreSQLDatabase({
      ...parseDatabaseUrl(databaseUrl),
      poolConfig: { max: 1, connectionTimeoutMillis: 3_000 },
      enableGracefulShutdown: false,
    });
    await database.executeQuery("SELECT 1 AS ok");
    return { ok: true, detail: "reachable" };
  } catch {
    return { ok: false, detail: "unreachable or rejected the connection" };
  } finally {
    await database?.disconnect().catch(() => undefined);
  }
}

/**
 * Checks that the keyring exists, has mode `0600`, and loads.
 *
 * @param keyringPath - Absolute keyring path.
 * @returns Probe status with the current key id and key count, never key bytes.
 */
export async function probeKeyring(keyringPath: string): Promise<
  OperationsProbe & {
    /** Current KEK identifier when the keyring loaded. */
    readonly currentId?: string;
    /** Number of retained keys when the keyring loaded. */
    readonly keyCount?: number;
  }
> {
  let keyring: KeyringProvider | undefined;
  try {
    keyring = await KeyringProvider.load(keyringPath);
    const status = keyring.status();
    return {
      ok: true,
      detail: `${status.keyCount} key(s), current ${status.currentId ?? "none"}`,
      ...(status.currentId === undefined ? {} : { currentId: status.currentId }),
      keyCount: status.keyCount,
    };
  } catch {
    return { ok: false, detail: "missing, unreadable, or not mode 0600" };
  } finally {
    keyring?.destroy();
  }
}
