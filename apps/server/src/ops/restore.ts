import { createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { decryptValue, type EncryptedValue, Keyring } from "@openvault/core";
import { runMigrations } from "blendsdk/codegen";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { AuditVerifier } from "../audit/audit-verify.js";
import { migrationConfigPath } from "../db/config.js";
import { parseDatabaseUrl } from "../db/url.js";
import { CaSigner } from "../security/ca.js";
import { KeyringProvider } from "../security/keyring.js";
import { openArchive } from "./archive.js";
import { recordOperationsEvent } from "./audit.js";
import {
  type DatabaseDump,
  hasUserData,
  openDatabaseClient,
  restoreDatabase,
  reviveValue,
  validateDump,
} from "./database-dump.js";
import { OpsError } from "./errors.js";
import { ensurePrivateDirectory, readBoundedRegularFile, writePrivateFileAtomic } from "./files.js";

/** Maximum accepted archive size. */
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

/** Options for one restore. */
export interface RestoreOptions {
  /** Absolute archive path. */
  readonly archivePath: string;
  /** Operator passphrase. */
  readonly passphrase: string;
  /** Application database URL after restore. */
  readonly databaseUrl: string;
  /** Optional owner/migrator URL used for DDL and data restore. */
  readonly restoreDatabaseUrl?: string;
  /** Absolute keyring path to write. */
  readonly keyringPath: string;
  /** Absolute public internal CA path to materialize. */
  readonly internalCaPath: string;
  /** Optional proxy CA directory that receives `ca.pem`. */
  readonly caPublicDir?: string;
  /** Replace a non-empty target. */
  readonly force: boolean;
  /** Injectable clock. */
  readonly now?: () => number;
}

/** Result of one restore. */
export interface RestoreResult {
  /** Rows restored. */
  readonly objectCount: number;
  /** Tables restored. */
  readonly tables: readonly string[];
  /** Audit-chain verification. */
  readonly auditOk: boolean;
  /** Number of current secret values decrypt-verified. */
  readonly secretsVerified: number;
  /** Whether the CA key signed a probe certificate. */
  readonly caVerified: boolean;
  /** Materialized public CA path. */
  readonly internalCaPath: string;
}

/** Returns the current CA row in the dump. */
function currentCaRow(dump: DatabaseDump): Readonly<Record<string, unknown>> {
  const current = (dump.tables.ca_keys ?? []).find((row) => row.status === "current");
  if (current === undefined || typeof current.cert_pem !== "string") {
    throw new OpsError("restore_archive_invalid", "The backup has no current CA row");
  }
  return current;
}

/** Decrypts one wrapped key with a core keyring. */
function decryptWrapped(
  keyring: Keyring,
  kekId: string,
  wrapped: Buffer,
  nonce: Buffer,
  tag: Buffer,
  aad: Buffer,
): Buffer {
  if (wrapped.length !== KEY_BYTES || nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new OpsError("restore_archive_invalid", "A wrapped key has invalid lengths");
  }
  return keyring.withKey(kekId, (key) => {
    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(wrapped), decipher.final()]);
    if (plaintext.length !== KEY_BYTES) {
      plaintext.fill(0);
      throw new OpsError("restore_archive_invalid", "A wrapped key has the wrong length");
    }
    return plaintext;
  });
}

/** Preflights the archive keyring against the CA, one audit key, and one secret. */
function preflightKeyring(dump: DatabaseDump, keyring: Keyring, caPem: string): void {
  const ca = currentCaRow(dump);
  if (ca.cert_pem !== caPem) {
    throw new OpsError(
      "restore_archive_invalid",
      "The archived public CA does not match the CA row",
    );
  }
  const caPlaintext = decryptWrapped(
    keyring,
    String(ca.kek_id),
    reviveValue(ca.wrapped_key) as Buffer,
    reviveValue(ca.wrap_nonce) as Buffer,
    reviveValue(ca.wrap_tag) as Buffer,
    Buffer.from(`ov:ca:v1:${String(ca.id)}`, "utf8"),
  );
  caPlaintext.fill(0);

  const audit = (dump.tables.audit_keys ?? [])[0];
  if (audit !== undefined) {
    const auditPlaintext = decryptWrapped(
      keyring,
      String(audit.kek_id),
      reviveValue(audit.wrapped_key) as Buffer,
      reviveValue(audit.wrap_nonce) as Buffer,
      reviveValue(audit.wrap_tag) as Buffer,
      Buffer.from(`ov:audit-key:v1:${String(audit.id)}:${String(audit.kek_id)}`, "utf8"),
    );
    auditPlaintext.fill(0);
  }

  const versions = new Map(
    (dump.tables.secret_versions ?? []).map((row) => [String(row.id), row] as const),
  );
  for (const secret of dump.tables.secrets ?? []) {
    const versionId = secret.current_version_id;
    if (typeof versionId !== "string") {
      continue;
    }
    const version = versions.get(versionId);
    if (version === undefined) {
      continue;
    }
    const envelope: EncryptedValue = {
      kekId: String(version.kek_id),
      nonce: (reviveValue(version.nonce) as Buffer).toString("base64"),
      tag: (reviveValue(version.tag) as Buffer).toString("base64"),
      ciphertext: (reviveValue(version.ciphertext) as Buffer).toString("base64"),
      wrapNonce: (reviveValue(version.wrap_nonce) as Buffer).toString("base64"),
      wrappedDek: (reviveValue(version.wrapped_dek) as Buffer).toString("base64"),
      wrapTag: (reviveValue(version.wrap_tag) as Buffer).toString("base64"),
    };
    let plaintext: Buffer | undefined;
    try {
      plaintext = decryptValue(
        envelope,
        {
          currentId: keyring.currentId,
          destroyed: keyring.destroyed,
          withCurrentKey: (action) => keyring.withCurrentKey(action),
          withKey: (id, action) => keyring.withKey(id, action),
        },
        {
          objectType: "secret",
          projectId: String(secret.project_id),
          objectId: String(secret.id),
          version: versionId,
        },
      );
      return;
    } finally {
      plaintext?.fill(0);
    }
  }
}

/** Runs migrations under the restore URL without leaking it. */
async function migrate(databaseUrl: string): Promise<void> {
  const previous = process.env.OPENVAULT_DB_URL;
  process.env.OPENVAULT_DB_URL = databaseUrl;
  try {
    await runMigrations({ command: "up", configPath: migrationConfigPath });
  } finally {
    if (previous === undefined) {
      delete process.env.OPENVAULT_DB_URL;
    } else {
      process.env.OPENVAULT_DB_URL = previous;
    }
  }
}

/** Verifies the audit chain, one current secret per project, and the CA key. */
async function verifyRestoredState(options: {
  readonly database: PostgreSQLDatabase;
  readonly keyring: KeyringProvider;
  readonly caPem: string;
  readonly now: () => number;
}): Promise<{
  readonly auditOk: boolean;
  readonly secretsVerified: number;
  readonly caVerified: boolean;
}> {
  const verifier = new AuditVerifier({
    database: options.database,
    keyring: options.keyring,
  });
  const audit = await verifier.verify();
  if (!audit.ok) {
    throw new OpsError(
      "restore_verification_failed",
      `The restored audit chain failed verification (${audit.reason})`,
    );
  }

  let secretsVerified = 0;
  const secrets = await options.database.executeQuery<{
    readonly project_id: string;
    readonly secret_id: string;
    readonly version_id: string;
    readonly kek_id: string;
    readonly nonce: Buffer;
    readonly tag: Buffer;
    readonly ciphertext: Buffer;
    readonly wrap_nonce: Buffer;
    readonly wrapped_dek: Buffer;
    readonly wrap_tag: Buffer;
  }>(
    `SELECT DISTINCT ON (p.id) p.id AS project_id, s.id AS secret_id, v.id AS version_id,
            v.kek_id, v.nonce, v.tag, v.ciphertext, v.wrap_nonce, v.wrapped_dek, v.wrap_tag
       FROM projects p
       JOIN secrets s ON s.project_id = p.id AND s.current_version_id IS NOT NULL
       JOIN secret_versions v ON v.id = s.current_version_id
      WHERE p.deleted_at IS NULL
      ORDER BY p.id, s.id`,
  );
  for (const row of secrets.records) {
    const envelope: EncryptedValue = {
      kekId: row.kek_id,
      nonce: row.nonce.toString("base64"),
      tag: row.tag.toString("base64"),
      ciphertext: row.ciphertext.toString("base64"),
      wrapNonce: row.wrap_nonce.toString("base64"),
      wrappedDek: row.wrapped_dek.toString("base64"),
      wrapTag: row.wrap_tag.toString("base64"),
    };
    let plaintext: Buffer | undefined;
    try {
      plaintext = decryptValue(envelope, options.keyring, {
        objectType: "secret",
        projectId: row.project_id,
        objectId: row.secret_id,
        version: row.version_id,
      });
      secretsVerified += 1;
    } catch (error) {
      throw new OpsError(
        "restore_verification_failed",
        "A restored secret could not be decrypted",
        {
          cause: error,
        },
      );
    } finally {
      plaintext?.fill(0);
    }
  }

  const signer = await CaSigner.load({
    database: options.database,
    keyring: options.keyring,
    caPem: options.caPem,
    now: options.now,
  });
  try {
    await signer.issueServerCertificate({
      subject: "CN=openvault-restore-probe",
      dnsNames: ["openvault-restore-probe"],
      ipAddresses: [],
    });
  } finally {
    signer.destroy();
  }
  return { auditOk: true, secretsVerified, caVerified: true };
}

/** Compares two database URLs by connection target, not role. */
function databaseIdentity(databaseUrl: string): string {
  let config: ReturnType<typeof parseDatabaseUrl>;
  try {
    config = parseDatabaseUrl(databaseUrl);
  } catch (error) {
    throw new OpsError("ops_configuration", "The database URL is invalid", { cause: error });
  }
  return `${config.host}:${config.port}/${config.database}`;
}

/** Best-effort directory fsync after a rename. */
function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // The rename itself is durable on most filesystems; this is best effort.
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

/** Publishes one staged file, returning the final path. */
function publish(staged: string, target: string): void {
  renameSync(staged, target);
  fsyncDirectory(dirname(target));
}

/**
 * Restores one encrypted archive into a migrated target.
 *
 * The archive, keyring, CA, checksums, and URL identity are verified before
 * the target is touched. Keyring and CA bytes are staged in their target
 * directories, the database is restored in one transaction, and the staged
 * files are published only after commit. There is no rollback to an old
 * keyring that would not match the restored database.
 *
 * @param options - Archive, target, keyring, CA, and policy.
 * @returns Restore and verification counts.
 */
export async function runRestore(options: RestoreOptions): Promise<RestoreResult> {
  const archivePath = resolve(options.archivePath);
  const keyringPath = resolve(options.keyringPath);
  const internalCaPath = resolve(options.internalCaPath);
  const caPublicDir = options.caPublicDir === undefined ? undefined : resolve(options.caPublicDir);
  const caPublicPath = caPublicDir === undefined ? undefined : join(caPublicDir, "ca.pem");
  if (
    keyringPath === internalCaPath ||
    keyringPath === archivePath ||
    internalCaPath === archivePath ||
    (caPublicPath !== undefined &&
      (caPublicPath === keyringPath ||
        caPublicPath === archivePath ||
        caPublicPath === internalCaPath))
  ) {
    throw new OpsError(
      "ops_configuration",
      "The archive, keyring, and public CA paths must be distinct",
    );
  }
  const restoreUrl = options.restoreDatabaseUrl ?? options.databaseUrl;
  if (databaseIdentity(restoreUrl) !== databaseIdentity(options.databaseUrl)) {
    throw new OpsError(
      "ops_configuration",
      "OPENVAULT_RESTORE_DB_URL and OPENVAULT_DB_URL must target the same database",
    );
  }

  const archive = readBoundedRegularFile(archivePath, MAX_ARCHIVE_BYTES, 0o600);
  const opened = await openArchive(archive, options.passphrase);
  let dump: DatabaseDump;
  try {
    dump = validateDump(JSON.parse(opened.files["database.json"]) as unknown);
  } catch (error) {
    if (error instanceof OpsError) {
      throw error;
    }
    throw new OpsError("restore_archive_invalid", "The database dump is not valid JSON", {
      cause: error,
    });
  }
  const caPem = opened.files["ca.pem"];
  const archiveKeyring = (() => {
    try {
      return Keyring.fromJSON(JSON.parse(opened.files["keyring.json"]) as unknown);
    } catch (error) {
      throw new OpsError("restore_archive_invalid", "The archived keyring is invalid", {
        cause: error,
      });
    }
  })();
  try {
    preflightKeyring(dump, archiveKeyring, caPem);
  } catch (error) {
    if (error instanceof OpsError) {
      throw error;
    }
    throw new OpsError(
      "restore_archive_invalid",
      "The archived keyring cannot decrypt the backup",
      { cause: error },
    );
  } finally {
    archiveKeyring.destroy();
  }

  if (!options.force) {
    const preflight = await openDatabaseClient(restoreUrl);
    try {
      if (await hasUserData(preflight)) {
        throw new OpsError(
          "restore_target_not_empty",
          "The restore target is not empty; use --force to replace it",
        );
      }
    } finally {
      await preflight.end();
    }
  }
  ensurePrivateDirectory(dirname(keyringPath));
  ensurePrivateDirectory(dirname(internalCaPath));
  if (caPublicDir !== undefined) {
    ensurePrivateDirectory(caPublicDir);
  }
  const stagingId = randomBytes(8).toString("hex");
  const keyringStage = join(dirname(keyringPath), `.keyring.restore-${stagingId}`);
  const caStage = join(dirname(internalCaPath), `.ca.restore-${stagingId}`);
  const caPublicStage =
    caPublicDir === undefined ? undefined : join(caPublicDir, `.ca.restore-${stagingId}`);
  try {
    writePrivateFileAtomic(keyringStage, Buffer.from(opened.files["keyring.json"], "utf8"), 0o600);
    writePrivateFileAtomic(caStage, Buffer.from(caPem, "utf8"), 0o644);
    if (caPublicStage !== undefined) {
      writePrivateFileAtomic(caPublicStage, Buffer.from(caPem, "utf8"), 0o644);
    }
  } catch (error) {
    rmSync(keyringStage, { force: true });
    rmSync(caStage, { force: true });
    if (caPublicStage !== undefined) {
      rmSync(caPublicStage, { force: true });
    }
    throw error;
  }

  let restored: { readonly objectCount: number; readonly tables: readonly string[] };
  try {
    await migrate(restoreUrl);
    const client = await openDatabaseClient(restoreUrl);
    try {
      restored = await restoreDatabase(client, dump, { force: options.force });
    } finally {
      await client.end();
    }
  } catch (error) {
    rmSync(keyringStage, { force: true });
    rmSync(caStage, { force: true });
    if (caPublicStage !== undefined) {
      rmSync(caPublicStage, { force: true });
    }
    throw error;
  }

  try {
    publish(keyringStage, keyringPath);
    publish(caStage, internalCaPath);
    if (caPublicStage !== undefined && caPublicDir !== undefined) {
      publish(caPublicStage, caPublicPath ?? join(caPublicDir, "ca.pem"));
    }
  } catch (error) {
    throw new OpsError(
      "restore_failed",
      "The database was restored, but the keyring/CA files could not be published; staged files remain for manual recovery",
      { cause: error },
    );
  }

  const database = new PostgreSQLDatabase({
    ...parseDatabaseUrl(options.databaseUrl),
    poolConfig: { connectionTimeoutMillis: 2_000 },
    enableGracefulShutdown: false,
  });
  const keyring = await KeyringProvider.load(keyringPath);
  try {
    let verified: Awaited<ReturnType<typeof verifyRestoredState>>;
    try {
      verified = await verifyRestoredState({
        database,
        keyring,
        caPem,
        now: options.now ?? Date.now,
      });
    } catch (error) {
      try {
        await recordOperationsEvent({
          database,
          keyring,
          action: "backup.restore",
          result: "error",
          details: {
            format: "openvault-backup",
            objectCount: restored.objectCount,
            phase: "error",
          },
          ...(options.now === undefined ? {} : { now: options.now }),
          requestId: "restore",
        });
      } catch {
        // Preserve the verification failure.
      }
      throw error;
    }
    await recordOperationsEvent({
      database,
      keyring,
      action: "backup.restore",
      result: "allow",
      details: {
        format: "openvault-backup",
        objectCount: restored.objectCount,
        phase: "complete",
      },
      ...(options.now === undefined ? {} : { now: options.now }),
      requestId: "restore",
    });
    return {
      objectCount: restored.objectCount,
      tables: restored.tables,
      auditOk: verified.auditOk,
      secretsVerified: verified.secretsVerified,
      caVerified: verified.caVerified,
      internalCaPath,
    };
  } finally {
    keyring.destroy();
    await database.disconnect();
  }
}
