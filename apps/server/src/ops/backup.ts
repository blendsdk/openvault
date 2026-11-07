import { resolve } from "node:path";
import { Keyring } from "@openvault/core";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { parseDatabaseUrl } from "../db/url.js";
import { KeyringProvider } from "../security/keyring.js";
import { type ArchiveFiles, createArchive, sha256Hex } from "./archive.js";
import { recordOperationsEvent } from "./audit.js";
import { buildConfigManifest } from "./config.js";
import { dumpDatabase, openDatabaseClient } from "./database-dump.js";
import { OpsError } from "./errors.js";
import { lstatIfExists, readBoundedRegularFile, writePrivateFileAtomic } from "./files.js";

/** Returns a stable host:port/database identity for one URL. */
function databaseIdentity(url: string): string {
  const parsed = parseDatabaseUrl(url);
  return `${parsed.host ?? ""}:${String(parsed.port ?? 5432)}/${parsed.database ?? ""}`;
}

/** Options for one logical backup. */
export interface BackupOptions {
  /** Application database URL used only for the `backup.create` audit event. */
  readonly databaseUrl: string;
  /** Dedicated read-only database URL used for the logical dump. */
  readonly backupDatabaseUrl: string;
  /** Absolute 0600 keyring path. */
  readonly keyringPath: string;
  /** Absolute public internal CA path. */
  readonly internalCaPath: string;
  /** Optional TLS certificate path for the redacted manifest. */
  readonly tlsCertPath?: string;
  /** Optional TLS key path for the redacted manifest. */
  readonly tlsKeyPath?: string;
  /** Absolute output archive path. */
  readonly outPath: string;
  /** Operator passphrase; never logged or serialized. */
  readonly passphrase: string;
  /** Replace an existing output. */
  readonly force?: boolean;
  /** Process environment used for the redacted manifest. */
  readonly env: NodeJS.ProcessEnv;
  /** Injectable clock. */
  readonly now?: () => number;
}

/** Result of one backup. */
export interface BackupResult {
  /** Archive path. */
  readonly outPath: string;
  /** Archive size in bytes. */
  readonly bytes: number;
  /** Archive SHA-256. */
  readonly sha256: string;
  /** Creation timestamp. */
  readonly createdAt: string;
  /** Restored row count. */
  readonly objectCount: number;
  /** Tables captured. */
  readonly tables: readonly string[];
}

/**
 * Creates one passphrase-encrypted logical backup.
 *
 * The archive contains a JSON row dump, the raw keyring, a redacted
 * configuration manifest, the public internal CA, and audit checkpoints. The
 * database password and every secret value remain outside the manifest.
 *
 * @param options - Database, files, output, passphrase, and policy.
 * @returns Archive metadata.
 */
export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  const outPath = resolve(options.outPath);
  const keyringPath = resolve(options.keyringPath);
  const internalCaPath = resolve(options.internalCaPath);
  if (outPath === keyringPath || outPath === internalCaPath) {
    throw new OpsError(
      "backup_target_exists",
      "The backup output must not overwrite the keyring or CA",
    );
  }
  if (lstatIfExists(outPath) !== undefined && options.force !== true) {
    throw new OpsError(
      "backup_target_exists",
      "The backup output already exists; use --force to replace it",
    );
  }
  try {
    if (databaseIdentity(options.backupDatabaseUrl) !== databaseIdentity(options.databaseUrl)) {
      throw new OpsError(
        "ops_configuration",
        "OPENVAULT_BACKUP_DB_URL and OPENVAULT_DB_URL must target the same database",
      );
    }
  } catch (error) {
    if (error instanceof OpsError) {
      throw error;
    }
    throw new OpsError("ops_configuration", "The backup database URLs are invalid");
  }
  const keyringBytes = readBoundedRegularFile(keyringPath, 1_048_576, 0o600);
  const keyring = await KeyringProvider.load(keyringPath);
  const client = await openDatabaseClient(options.backupDatabaseUrl);
  let auditDatabase: PostgreSQLDatabase | undefined;
  let objectCount = 0;
  try {
    const identity = await client.query<{
      readonly session_user: string;
      readonly can_read_credentials: boolean;
      readonly can_read_audit: boolean;
    }>(
      `SELECT session_user,
              has_table_privilege(current_user, 'local_credentials', 'SELECT')
                AS can_read_credentials,
              has_table_privilege(current_user, 'audit_events', 'SELECT')
                AS can_read_audit`,
    );
    const role = identity.rows[0];
    if (
      role === undefined ||
      role.session_user === "openvault_app" ||
      role.session_user === "openvault_auth" ||
      role.can_read_credentials !== true ||
      role.can_read_audit !== true
    ) {
      throw new OpsError(
        "backup_role_required",
        "The backup dump must use the dedicated openvault_backup role; set OPENVAULT_BACKUP_DB_URL",
      );
    }

    auditDatabase = new PostgreSQLDatabase({
      ...parseDatabaseUrl(options.databaseUrl),
      poolConfig: { connectionTimeoutMillis: 2_000 },
      enableGracefulShutdown: false,
    });
    const dump = await dumpDatabase(client);
    // A concurrent KEK rotation must not pair the DB snapshot with a new
    // keyring. Re-read and require the exact bytes used for the snapshot.
    const keyringAfter = readBoundedRegularFile(keyringPath, 1_048_576, 0o600);
    if (!keyringAfter.equals(keyringBytes)) {
      throw new OpsError(
        "backup_failed",
        "The keyring changed during backup; stop writes or retry the backup",
      );
    }
    const caPem = readBoundedRegularFile(internalCaPath, 1_048_576, 0o644).toString("utf8");
    const currentCa = (dump.tables.ca_keys ?? []).find((row) => row.status === "current");
    if (typeof currentCa?.cert_pem !== "string" || currentCa.cert_pem !== caPem) {
      throw new OpsError(
        "backup_failed",
        "The configured public CA does not match the database CA row",
      );
    }
    const parsedKeyring = Keyring.fromJSON(JSON.parse(keyringBytes.toString("utf8")) as unknown);
    try {
      for (const [table, rows] of Object.entries(dump.tables)) {
        if (
          table !== "secret_versions" &&
          table !== "certificate_versions" &&
          table !== "audit_keys" &&
          table !== "ca_keys" &&
          table !== "signing_keys"
        ) {
          continue;
        }
        for (const row of rows) {
          const kekId = row.kek_id;
          if (typeof kekId === "string" && !parsedKeyring.has(kekId)) {
            throw new OpsError(
              "backup_failed",
              `The backup references a KEK that is missing from the keyring`,
            );
          }
        }
      }
    } finally {
      parsedKeyring.destroy();
    }
    const checkpoints = (dump.tables.audit_checkpoints ?? [])
      .map((row) => JSON.stringify(row))
      .join("\n");
    const config = buildConfigManifest({
      env: options.env,
      databaseUrl: options.databaseUrl,
      keyringPath,
      internalCaPath,
      ...(options.tlsCertPath === undefined ? {} : { tlsCertPath: options.tlsCertPath }),
      ...(options.tlsKeyPath === undefined ? {} : { tlsKeyPath: options.tlsKeyPath }),
    });
    const files: ArchiveFiles = {
      "database.json": JSON.stringify(dump),
      "keyring.json": keyringBytes.toString("utf8"),
      "config.json": JSON.stringify(config),
      "ca.pem": caPem,
      "checkpoints.ndjson": checkpoints.length === 0 ? "" : `${checkpoints}\n`,
    };
    const now = new Date((options.now ?? Date.now)());
    const archive = await createArchive(files, {
      passphrase: options.passphrase,
      now,
    });
    if (archive.length > 2 * 1024 * 1024 * 1024) {
      throw new OpsError("backup_failed", "The backup archive exceeds the 2 GiB restore limit");
    }
    objectCount = Object.values(dump.tables).reduce((total, rows) => total + rows.length, 0);
    writePrivateFileAtomic(outPath, archive, 0o600);
    await recordOperationsEvent({
      database: auditDatabase,
      keyring,
      action: "backup.create",
      result: "allow",
      details: { format: "openvault-backup", objectCount, phase: "complete" },
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return {
      outPath,
      bytes: archive.length,
      sha256: sha256Hex(archive),
      createdAt: now.toISOString(),
      objectCount,
      tables: Object.keys(dump.tables).sort(),
    };
  } catch (error) {
    if (auditDatabase !== undefined) {
      try {
        await recordOperationsEvent({
          database: auditDatabase,
          keyring,
          action: "backup.create",
          result: "error",
          details: { format: "openvault-backup", objectCount, phase: "error" },
          ...(options.now === undefined ? {} : { now: options.now }),
        });
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  } finally {
    await client.end();
    await auditDatabase?.disconnect();
    keyring.destroy();
  }
}
