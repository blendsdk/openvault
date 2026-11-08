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
import { SigningKeyRepository, SigningKeyService } from "../security/signing-keys.js";
import { verifyAgentCertificateProfile, x509 } from "../security/x509.js";
import { openArchive, sha256Hex } from "./archive.js";
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
  /**
   * Optional agent certificate captured before the backup.
   *
   * The v1.0 schema stores agent certificate metadata but not the leaf PEM, so
   * the restore drill supplies the certificate it saved before the backup. The
   * restore verifies its signature, profile, and validity against the restored
   * CA.
   */
  readonly agentCertificatePath?: string;
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
  /** Number of current certificate private keys decrypt-verified. */
  readonly certificatesVerified: number;
  /** Whether the restored JWT signing key signed and verified a probe token. */
  readonly signingKeyVerified: boolean;
  /** Whether the CA key signed a probe certificate. */
  readonly caVerified: boolean;
  /** Whether a supplied pre-backup agent certificate chained to the CA. */
  readonly agentCertificateVerified: boolean;
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

  for (const audit of dump.tables.audit_keys ?? []) {
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

  for (const signing of dump.tables.signing_keys ?? []) {
    const seed = decryptWrapped(
      keyring,
      String(signing.kek_id),
      reviveValue(signing.wrapped_seed) as Buffer,
      reviveValue(signing.wrap_nonce) as Buffer,
      reviveValue(signing.wrap_tag) as Buffer,
      Buffer.from(`ov:jwt:v1:${String(signing.kid)}`, "utf8"),
    );
    seed.fill(0);
  }

  const secretVersions = new Map(
    (dump.tables.secret_versions ?? []).map((row) => [String(row.id), row] as const),
  );
  for (const secret of dump.tables.secrets ?? []) {
    const versionId = secret.current_version_id;
    if (typeof versionId !== "string") {
      continue;
    }
    const version = secretVersions.get(versionId);
    if (version === undefined) {
      throw new OpsError(
        "restore_archive_invalid",
        "A secret references a version that is missing from the dump",
      );
    }
    decryptEnvelopeRow(
      keyring,
      version,
      {
        objectType: "secret",
        projectId: String(secret.project_id),
        objectId: String(secret.id),
        version: versionId,
      },
      "restore_archive_invalid",
    );
  }

  const certificateVersions = new Map(
    (dump.tables.certificate_versions ?? []).map((row) => [String(row.id), row] as const),
  );
  for (const certificate of dump.tables.certificates ?? []) {
    const versionId = certificate.current_version_id;
    if (typeof versionId !== "string") {
      continue;
    }
    const version = certificateVersions.get(versionId);
    if (version === undefined) {
      throw new OpsError(
        "restore_archive_invalid",
        "A certificate references a version that is missing from the dump",
      );
    }
    decryptEnvelopeRow(
      keyring,
      version,
      {
        objectType: "certificate",
        projectId: String(certificate.project_id),
        objectId: String(certificate.id),
        version: versionId,
      },
      "restore_archive_invalid",
    );
  }
}

/** Decrypts one envelope row and zeroes the plaintext. */
function decryptEnvelopeRow(
  keyring: Keyring,
  version: Readonly<Record<string, unknown>>,
  aad: {
    readonly objectType: "secret" | "certificate";
    readonly projectId: string;
    readonly objectId: string;
    readonly version: string;
  },
  code: "restore_archive_invalid" | "restore_verification_failed",
): void {
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
      aad,
    );
  } catch (error) {
    throw new OpsError(code, "An archived envelope could not be decrypted", { cause: error });
  } finally {
    plaintext?.fill(0);
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

/**
 * Verifies one operator-supplied agent certificate against the restored CA.
 *
 * The certificate must be a valid client certificate for a principal id, and
 * its validity window must include the restore clock. The caller passes the
 * certificate that was captured before the backup; the database does not store
 * agent leaf PEMs in v1.0.
 */
async function verifyAgentCertificate(
  certificatePem: string,
  caPem: string,
  now: number,
): Promise<void> {
  const certificate = new x509.X509Certificate(certificatePem);
  const caCertificate = new x509.X509Certificate(caPem);
  const commonName = certificate.subjectName.getField("CN")[0];
  if (commonName === undefined || commonName.length === 0) {
    throw new OpsError(
      "restore_verification_failed",
      "The supplied agent certificate has no principal common name",
    );
  }
  const notBefore = certificate.notBefore.getTime();
  const notAfter = certificate.notAfter.getTime();
  const skewMs = 30_000;
  if (now + skewMs < notBefore || now - skewMs > notAfter) {
    throw new OpsError(
      "restore_verification_failed",
      "The supplied agent certificate is not valid at restore time",
    );
  }
  try {
    await verifyAgentCertificateProfile(certificatePem, caCertificate, commonName);
  } catch {
    throw new OpsError(
      "restore_verification_failed",
      "The supplied agent certificate does not match the restored CA or agent profile",
    );
  }
}

/** Verifies the audit chain, one current secret per project, and the CA key. */
async function verifyRestoredState(options: {
  readonly database: PostgreSQLDatabase;
  readonly keyring: KeyringProvider;
  readonly caPem: string;
  readonly agentCertificatePem?: string;
  readonly now: () => number;
}): Promise<{
  readonly auditOk: boolean;
  readonly secretsVerified: number;
  readonly certificatesVerified: number;
  readonly signingKeyVerified: boolean;
  readonly caVerified: boolean;
  readonly agentCertificateVerified: boolean;
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
    `SELECT p.id AS project_id, s.id AS secret_id, v.id AS version_id,
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

  let certificatesVerified = 0;
  const certificates = await options.database.executeQuery<{
    readonly project_id: string;
    readonly certificate_id: string;
    readonly version_id: string;
    readonly kek_id: string;
    readonly nonce: Buffer;
    readonly tag: Buffer;
    readonly ciphertext: Buffer;
    readonly wrap_nonce: Buffer;
    readonly wrapped_dek: Buffer;
    readonly wrap_tag: Buffer;
  }>(
    `SELECT c.project_id, c.id AS certificate_id, v.id AS version_id,
            v.kek_id, v.nonce, v.tag, v.ciphertext, v.wrap_nonce, v.wrapped_dek, v.wrap_tag
       FROM certificates c
       JOIN projects p ON p.id = c.project_id
       JOIN certificate_versions v ON v.id = c.current_version_id
      WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY c.project_id, c.id`,
  );
  for (const row of certificates.records) {
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
        objectType: "certificate",
        projectId: row.project_id,
        objectId: row.certificate_id,
        version: row.version_id,
      });
      certificatesVerified += 1;
    } catch (error) {
      throw new OpsError(
        "restore_verification_failed",
        "A restored certificate private key could not be decrypted",
        { cause: error },
      );
    } finally {
      plaintext?.fill(0);
    }
  }

  const signingKeys = new SigningKeyService({
    repository: new SigningKeyRepository(options.database),
    keyring: options.keyring,
    now: options.now,
  });
  try {
    const token = await signingKeys.signAccessToken({
      principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      familyId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      nowMs: options.now(),
    });
    await signingKeys.verifyAccessToken(token.token);
  } catch (error) {
    throw new OpsError(
      "restore_verification_failed",
      "The restored JWT signing key could not sign and verify a probe token",
      { cause: error },
    );
  } finally {
    signingKeys.destroy();
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
  if (options.agentCertificatePem !== undefined) {
    await verifyAgentCertificate(options.agentCertificatePem, options.caPem, options.now());
  }
  return {
    auditOk: true,
    secretsVerified,
    certificatesVerified,
    signingKeyVerified: true,
    caVerified: true,
    agentCertificateVerified: options.agentCertificatePem !== undefined,
  };
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
  const agentCertificatePath =
    options.agentCertificatePath === undefined ? undefined : resolve(options.agentCertificatePath);
  if (
    keyringPath === internalCaPath ||
    keyringPath === archivePath ||
    internalCaPath === archivePath ||
    (agentCertificatePath !== undefined &&
      (agentCertificatePath === keyringPath ||
        agentCertificatePath === archivePath ||
        agentCertificatePath === internalCaPath)) ||
    (caPublicPath !== undefined &&
      (caPublicPath === keyringPath ||
        caPublicPath === archivePath ||
        caPublicPath === internalCaPath))
  ) {
    throw new OpsError(
      "ops_configuration",
      "The archive, keyring, public CA, and agent certificate paths must be distinct",
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
  const archiveSha256 = sha256Hex(archive);
  const archiveCreatedAt = opened.manifest.createdAt;
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
  const agentCertificatePem =
    agentCertificatePath === undefined
      ? undefined
      : readBoundedRegularFile(agentCertificatePath, 1_048_576, 0o644).toString("utf8");
  if (agentCertificatePem !== undefined) {
    await verifyAgentCertificate(
      agentCertificatePem,
      caPem,
      options.now === undefined ? Date.now() : options.now(),
    );
  }
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
        ...(agentCertificatePem === undefined ? {} : { agentCertificatePem }),
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
            archiveSha256,
            archiveCreatedAt,
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
        archiveSha256,
        archiveCreatedAt,
        secretsVerified: verified.secretsVerified,
        certificatesVerified: verified.certificatesVerified,
      },
      ...(options.now === undefined ? {} : { now: options.now }),
      requestId: "restore",
    });
    return {
      objectCount: restored.objectCount,
      tables: restored.tables,
      auditOk: verified.auditOk,
      secretsVerified: verified.secretsVerified,
      certificatesVerified: verified.certificatesVerified,
      signingKeyVerified: verified.signingKeyVerified,
      caVerified: verified.caVerified,
      agentCertificateVerified: verified.agentCertificateVerified,
      internalCaPath,
    };
  } finally {
    keyring.destroy();
    await database.disconnect();
  }
}
