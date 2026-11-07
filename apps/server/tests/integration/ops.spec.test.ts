import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptValue, encryptValue, newUlid } from "@openvault/core";
import { Encrypter } from "age-encryption";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditVerifier } from "../../src/audit/audit-verify.js";
import { runInit } from "../../src/init/index.js";
import { openArchive } from "../../src/ops/archive.js";
import { recordOperationsEvent } from "../../src/ops/audit.js";
import { type BackupResult, runBackup } from "../../src/ops/backup.js";
import { runKekRotate } from "../../src/ops/kek.js";
import { runRestore } from "../../src/ops/restore.js";
import { CaSigner } from "../../src/security/ca.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import { SigningKeyRepository, SigningKeyService } from "../../src/security/signing-keys.js";
import { parseAgentCsr } from "../../src/security/x509.js";
import { createAgentCsr } from "./helpers/agent-tls.js";
import {
  applyMigrations,
  createTestDatabase,
  resolveTestDatabaseSettings,
  type TestDatabase,
} from "./helpers/test-database.js";

const PASSPHRASE = "correct horse battery staple";
const directories: string[] = [];

let primaryDb: TestDatabase;
let secondaryDb: TestDatabase;
let directory: string;
let secondaryDirectory: string;
let keyringPath: string;
let internalCaPath: string;
let backup: BackupResult;
let projectId: string;
let secretId: string;
let versionId: string;
let certificateId: string;
let certificateVersionId: string;
let secretCiphertext: Buffer;
let adminId: string;
let agentCertificatePath: string;

function tempDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "openvault-ops-"));
  directories.push(path);
  return path;
}

beforeAll(async () => {
  primaryDb = await createTestDatabase();
  await applyMigrations(primaryDb);
  secondaryDb = await createTestDatabase();
  await applyMigrations(secondaryDb);
  directory = tempDirectory();
  secondaryDirectory = tempDirectory();
  keyringPath = join(directory, "keyring.json");
  internalCaPath = join(directory, "ca.pem");
  await runInit({
    databaseUrl: primaryDb.url,
    migrationDatabaseUrl: primaryDb.url,
    keyringPath,
    internalCaPath,
    tlsCertPath: join(directory, "server.crt"),
    tlsKeyPath: join(directory, "server.key"),
    baseUrl: "https://localhost",
    orgName: "Ops",
    adminName: "Ops Admin",
    adminEmail: "ops@example.test",
    generatePassword: true,
    bootstrapPasswordFile: join(directory, "bootstrap.txt"),
  });

  const admin = await primaryDb.db.executeQuery<{ id: string }>(
    "SELECT id FROM principals WHERE email = :email",
    { email: "ops@example.test" },
  );
  adminId = admin.records[0]?.id ?? "";
  projectId = newUlid();
  secretId = newUlid();
  versionId = newUlid();
  certificateId = newUlid();
  certificateVersionId = newUlid();
  const keyring = await KeyringProvider.load(keyringPath);
  try {
    const secretEnvelope = encryptValue(Buffer.from("restore-me", "utf8"), keyring, {
      objectType: "secret",
      projectId,
      objectId: secretId,
      version: versionId,
    });
    const certificateEnvelope = encryptValue(Buffer.from("cert-data", "utf8"), keyring, {
      objectType: "certificate",
      projectId,
      objectId: certificateId,
      version: certificateVersionId,
    });
    await primaryDb.db.executeQuery("INSERT INTO projects (id, name) VALUES (:id, 'ops-project')", {
      id: projectId,
    });
    await primaryDb.db.executeQuery(
      `INSERT INTO secrets (id, project_id, name, content_type, tags, purge_protected)
       VALUES (:id, :projectId, 'restore-me', 'text/plain', '{}'::jsonb, false)`,
      { id: secretId, projectId },
    );
    await primaryDb.db.executeQuery(
      `INSERT INTO secret_versions
         (id, secret_id, ciphertext, nonce, tag, wrapped_dek, wrap_nonce, wrap_tag, kek_id, created_by)
       VALUES
         (:id, :secretId, :ciphertext, :nonce, :tag, :wrappedDek, :wrapNonce, :wrapTag, :kekId, :createdBy)`,
      {
        id: versionId,
        secretId,
        ciphertext: Buffer.from(secretEnvelope.ciphertext, "base64"),
        nonce: Buffer.from(secretEnvelope.nonce, "base64"),
        tag: Buffer.from(secretEnvelope.tag, "base64"),
        wrappedDek: Buffer.from(secretEnvelope.wrappedDek, "base64"),
        wrapNonce: Buffer.from(secretEnvelope.wrapNonce, "base64"),
        wrapTag: Buffer.from(secretEnvelope.wrapTag, "base64"),
        kekId: secretEnvelope.kekId,
        createdBy: adminId,
      },
    );
    await primaryDb.db.executeQuery(
      "UPDATE secrets SET current_version_id = :versionId WHERE id = :id",
      { id: secretId, versionId },
    );
    secretCiphertext = Buffer.from(secretEnvelope.ciphertext, "base64");

    await primaryDb.db.executeQuery(
      `INSERT INTO certificates (id, project_id, name, tags, purge_protected)
       VALUES (:id, :projectId, 'restore-cert', '{}'::jsonb, false)`,
      { id: certificateId, projectId },
    );
    await primaryDb.db.executeQuery(
      `INSERT INTO certificate_versions
         (id, certificate_id, chain_pem, ciphertext, nonce, tag, wrapped_dek, wrap_nonce,
          wrap_tag, kek_id, fingerprint, subject, sans, issuer, serial, not_before, not_after,
          created_by)
       VALUES
         (:id, :certificateId, :chain, :ciphertext, :nonce, :tag, :wrappedDek, :wrapNonce,
          :wrapTag, :kekId, :fingerprint, :subject, '["DNS:ops"]'::jsonb, :issuer, :serial,
          now(), now() + interval '365 days', :createdBy)`,
      {
        id: certificateVersionId,
        certificateId,
        chain: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
        ciphertext: Buffer.from(certificateEnvelope.ciphertext, "base64"),
        nonce: Buffer.from(certificateEnvelope.nonce, "base64"),
        tag: Buffer.from(certificateEnvelope.tag, "base64"),
        wrappedDek: Buffer.from(certificateEnvelope.wrappedDek, "base64"),
        wrapNonce: Buffer.from(certificateEnvelope.wrapNonce, "base64"),
        wrapTag: Buffer.from(certificateEnvelope.wrapTag, "base64"),
        kekId: certificateEnvelope.kekId,
        fingerprint: "a".repeat(64),
        subject: "CN=ops",
        issuer: "CN=OpenVault Internal CA",
        serial: "01",
        createdBy: adminId,
      },
    );
    await primaryDb.db.executeQuery(
      "UPDATE certificates SET current_version_id = :versionId WHERE id = :id",
      { id: certificateId, versionId: certificateVersionId },
    );
    const agentCsr = await createAgentCsr();
    const signer = await CaSigner.load({
      database: primaryDb.db,
      keyring,
      caPem: readFileSync(internalCaPath, "utf8"),
      now: Date.now,
    });
    try {
      const issued = await signer.issueClientCertificate(
        await parseAgentCsr(agentCsr.csrPem),
        newUlid(),
        30,
      );
      agentCertificatePath = join(directory, "pre-backup-agent.pem");
      writeFileSync(agentCertificatePath, issued.certificatePem, { mode: 0o644 });
    } finally {
      signer.destroy();
    }
    await recordOperationsEvent({
      database: primaryDb.db,
      keyring,
      action: "backup.create",
      result: "allow",
      details: { format: "openvault-backup", objectCount: 1 },
      requestId: "test-seed",
    });
  } finally {
    keyring.destroy();
  }

  backup = await runBackup({
    databaseUrl: primaryDb.url,
    backupDatabaseUrl: primaryDb.url,
    keyringPath,
    internalCaPath,
    outPath: join(directory, "backup.age"),
    passphrase: PASSPHRASE,
    env: {},
  });
});

afterAll(async () => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  await secondaryDb?.cleanup();
  await primaryDb?.cleanup();
});

describe("operations", () => {
  it("should create a verifiable encrypted archive and reject tampering", async () => {
    expect(backup.bytes).toBeGreaterThan(0);
    expect(statSync(backup.outPath).mode & 0o777).toBe(0o600);
    const opened = await openArchive(readFileSync(backup.outPath), PASSPHRASE);
    expect(opened.manifest.format).toBe("openvault-backup");
    expect(opened.files["database.json"]).toContain("ops-project");
    expect(opened.files["ca.pem"]).toContain("BEGIN CERTIFICATE");
    expect(opened.files["checkpoints.ndjson"]).toBeTypeOf("string");

    await expect(
      openArchive(readFileSync(backup.outPath), "wrong passphrase"),
    ).rejects.toMatchObject({
      code: "backup_archive_invalid",
    });
    const tampered = Buffer.from(readFileSync(backup.outPath));
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    await expect(openArchive(tampered, PASSPHRASE)).rejects.toMatchObject({
      code: "backup_archive_invalid",
    });

    const encrypter = new Encrypter();
    encrypter.setPassphrase(PASSPHRASE);
    const checksumMismatch = await encrypter.encrypt(
      Buffer.from(
        JSON.stringify({
          manifest: opened.manifest,
          files: { ...opened.files, "ca.pem": `${opened.files["ca.pem"]}tampered` },
        }),
        "utf8",
      ),
    );
    await expect(openArchive(Buffer.from(checksumMismatch), PASSPHRASE)).rejects.toMatchObject({
      code: "backup_checksum_mismatch",
    });
  });

  it("should restore into an empty target and verify secrets, audit, CA, and agent certificate", async () => {
    await expect(
      runRestore({
        archivePath: backup.outPath,
        passphrase: PASSPHRASE,
        databaseUrl: secondaryDb.url,
        restoreDatabaseUrl: secondaryDb.url,
        keyringPath: join(secondaryDirectory, "keyring.json"),
        internalCaPath: join(secondaryDirectory, "ca.pem"),
        agentCertificatePath: internalCaPath,
        force: false,
      }),
    ).rejects.toMatchObject({ code: "restore_verification_failed" });
    expect(readdirSync(secondaryDirectory)).toHaveLength(0);

    const result = await runRestore({
      archivePath: backup.outPath,
      passphrase: PASSPHRASE,
      databaseUrl: secondaryDb.url,
      restoreDatabaseUrl: secondaryDb.url,
      keyringPath: join(secondaryDirectory, "keyring.json"),
      internalCaPath: join(secondaryDirectory, "ca.pem"),
      agentCertificatePath,
      force: false,
    });
    expect(result.objectCount).toBeGreaterThan(0);
    expect(result.auditOk).toBe(true);
    expect(result.secretsVerified).toBe(1);
    expect(result.certificatesVerified).toBe(1);
    expect(result.signingKeyVerified).toBe(true);
    expect(result.caVerified).toBe(true);
    expect(result.agentCertificateVerified).toBe(true);
    expect(statSync(join(secondaryDirectory, "keyring.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(secondaryDirectory, "ca.pem")).mode & 0o777).toBe(0o644);
    const projects = await secondaryDb.db.executeQuery<{ count: string }>(
      "SELECT count(*)::text AS count FROM projects WHERE name = 'ops-project'",
    );
    expect(Number(projects.records[0]?.count)).toBe(1);
    const triggers = await secondaryDb.db.executeQuery<{ enabled: boolean }>(
      `SELECT bool_and(tgenabled <> 'D') AS enabled
         FROM pg_trigger
        WHERE tgrelid = 'audit_events'::regclass AND NOT tgisinternal`,
    );
    expect(triggers.records[0]?.enabled).toBe(true);
  });

  it("should refuse a non-empty target and replace it only with --force", async () => {
    await expect(
      runRestore({
        archivePath: backup.outPath,
        passphrase: PASSPHRASE,
        databaseUrl: secondaryDb.url,
        restoreDatabaseUrl: secondaryDb.url,
        keyringPath: join(secondaryDirectory, "keyring.json"),
        internalCaPath: join(secondaryDirectory, "ca.pem"),
        force: false,
      }),
    ).rejects.toMatchObject({ code: "restore_target_not_empty" });
    expect(
      readdirSync(secondaryDirectory).some((name) => name.startsWith(".keyring.restore-")),
    ).toBe(false);
    const forced = await runRestore({
      archivePath: backup.outPath,
      passphrase: PASSPHRASE,
      databaseUrl: secondaryDb.url,
      restoreDatabaseUrl: secondaryDb.url,
      keyringPath: join(secondaryDirectory, "keyring.json"),
      internalCaPath: join(secondaryDirectory, "ca.pem"),
      force: true,
    });
    expect(forced.objectCount).toBeGreaterThan(0);
  });

  it("should restore as a non-superuser table owner", async () => {
    const settings = resolveTestDatabaseSettings();
    const suffix = randomBytes(4).toString("hex");
    const role = `ops_owner_${suffix}`;
    const database = `ops_owner_${suffix}_test`;
    const admin = new Client({ connectionString: settings.maintenanceUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'owner-password' NOSUPERUSER`);
      await admin.query(`CREATE DATABASE ${database} OWNER ${role}`);
    } finally {
      await admin.end();
    }
    const ownerUrl = `postgres://${role}:owner-password@${settings.host}:${settings.port}/${database}`;
    const ownerDirectory = tempDirectory();
    try {
      await applyMigrations({
        db: primaryDb.db,
        name: database,
        url: ownerUrl,
        cleanup: async () => undefined,
      });
      const restored = await runRestore({
        archivePath: backup.outPath,
        passphrase: PASSPHRASE,
        databaseUrl: ownerUrl,
        restoreDatabaseUrl: ownerUrl,
        keyringPath: join(ownerDirectory, "keyring.json"),
        internalCaPath: join(ownerDirectory, "ca.pem"),
        force: false,
      });
      expect(restored.objectCount).toBeGreaterThan(0);
      expect(restored.auditOk).toBe(true);
      const rotated = await runKekRotate({
        databaseUrl: ownerUrl,
        keyringPath: join(ownerDirectory, "keyring.json"),
      });
      expect(rotated.oldKeyRemoved).toBe(true);
    } finally {
      const cleanup = new Client({ connectionString: settings.maintenanceUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${database}`);
        await cleanup.query(`DROP ROLE IF EXISTS ${role}`);
      } finally {
        await cleanup.end();
      }
    }
  }, 120_000);

  it("should refuse a backup dump through the application role", async () => {
    const settings = resolveTestDatabaseSettings();
    const admin = new Client({ connectionString: settings.maintenanceUrl });
    await admin.connect();
    try {
      await admin.query(
        `DO $$
         BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openvault_app') THEN
             CREATE ROLE openvault_app LOGIN PASSWORD 'app-password';
           END IF;
         END
         $$`,
      );
    } finally {
      await admin.end();
    }
    const appUrl = `postgres://openvault_app:app-password@${settings.host}:${settings.port}/${primaryDb.name}`;
    const out = join(tempDirectory(), "app-role-backup.age");
    await expect(
      runBackup({
        databaseUrl: appUrl,
        backupDatabaseUrl: appUrl,
        keyringPath,
        internalCaPath,
        outPath: out,
        passphrase: PASSPHRASE,
        env: {},
      }),
    ).rejects.toMatchObject({ code: "backup_role_required" });
  });

  it("should refuse a backup dump through the auth role", async () => {
    const settings = resolveTestDatabaseSettings();
    const admin = new Client({ connectionString: settings.maintenanceUrl });
    await admin.connect();
    try {
      await admin.query(
        `DO $$
         BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openvault_auth') THEN
             CREATE ROLE openvault_auth LOGIN PASSWORD 'auth-password';
           ELSE
             ALTER ROLE openvault_auth PASSWORD 'auth-password';
           END IF;
         END
         $$`,
      );
    } finally {
      await admin.end();
    }
    const authUrl = `postgres://openvault_auth:auth-password@${settings.host}:${settings.port}/${primaryDb.name}`;
    await expect(
      runBackup({
        databaseUrl: authUrl,
        backupDatabaseUrl: authUrl,
        keyringPath,
        internalCaPath,
        outPath: join(tempDirectory(), "auth-role-backup.age"),
        passphrase: PASSPHRASE,
        env: {},
      }),
    ).rejects.toMatchObject({ code: "backup_role_required" });
  });

  it("should dump through the read-only backup role and audit through the app role", async () => {
    const settings = resolveTestDatabaseSettings();
    const admin = new Client({ connectionString: settings.maintenanceUrl });
    await admin.connect();
    try {
      await admin.query(
        `DO $$
         BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openvault_backup') THEN
             CREATE ROLE openvault_backup LOGIN PASSWORD 'backup-password';
           ELSE
             ALTER ROLE openvault_backup PASSWORD 'backup-password';
           END IF;
         END
         $$`,
      );
    } finally {
      await admin.end();
    }
    await primaryDb.db.executeQuery("GRANT USAGE ON SCHEMA public TO openvault_backup");
    await primaryDb.db.executeQuery(
      "GRANT SELECT ON ALL TABLES IN SCHEMA public TO openvault_backup",
    );
    const backupUrl = `postgres://openvault_backup:backup-password@${settings.host}:${settings.port}/${primaryDb.name}`;
    const result = await runBackup({
      databaseUrl: primaryDb.url,
      backupDatabaseUrl: backupUrl,
      keyringPath,
      internalCaPath,
      outPath: join(tempDirectory(), "backup-role.age"),
      passphrase: PASSPHRASE,
      env: {},
    });
    expect(result.objectCount).toBeGreaterThan(0);
    const events = await primaryDb.db.executeQuery<{ readonly count: number }>(
      "SELECT count(*)::int AS count FROM audit_events WHERE action = 'backup.create'",
    );
    expect(events.records[0]?.count).toBeGreaterThan(0);
  });

  it("should refuse a backup dump that targets a different database", async () => {
    await expect(
      runBackup({
        databaseUrl: primaryDb.url,
        backupDatabaseUrl: secondaryDb.url,
        keyringPath,
        internalCaPath,
        outPath: join(tempDirectory(), "wrong-database.age"),
        passphrase: PASSPHRASE,
        env: {},
      }),
    ).rejects.toMatchObject({ code: "ops_configuration" });
  });

  it("should refuse KEK rotation while the runtime role is connected", async () => {
    const settings = resolveTestDatabaseSettings();
    const admin = new Client({ connectionString: settings.maintenanceUrl });
    await admin.connect();
    try {
      await admin.query(
        `DO $$
         BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openvault_app') THEN
             CREATE ROLE openvault_app LOGIN PASSWORD 'app-password';
           END IF;
         END
         $$`,
      );
    } finally {
      await admin.end();
    }
    const app = new Client({
      connectionString: `postgres://openvault_app:app-password@${settings.host}:${settings.port}/${primaryDb.name}`,
    });
    await app.connect();
    try {
      await expect(runKekRotate({ databaseUrl: primaryDb.url, keyringPath })).rejects.toMatchObject(
        { code: "kek_rotation_server_running" },
      );
    } finally {
      await app.end();
    }
  });

  it("should rotate the KEK and keep value ciphertext byte-identical", async () => {
    const dry = await runKekRotate({
      databaseUrl: primaryDb.url,
      keyringPath,
      dryRun: true,
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.counts.secretVersions).toBe(1);
    expect(dry.counts.certificateVersions).toBe(1);
    expect(dry.counts.auditKeys).toBeGreaterThan(0);
    expect(dry.counts.caKeys).toBe(1);
    expect(dry.counts.signingKeys).toBe(1);

    const rotated = await runKekRotate({ databaseUrl: primaryDb.url, keyringPath });
    expect(rotated.oldKeyRemoved).toBe(true);
    expect(rotated.newKekId).not.toBe(rotated.oldKekId);
    expect(rotated.counts).toEqual(dry.counts);

    const version = await primaryDb.db.executeQuery<{ ciphertext: Buffer; kek_id: string }>(
      "SELECT ciphertext, kek_id FROM secret_versions WHERE id = :id",
      { id: versionId },
    );
    expect(version.records[0]?.ciphertext.equals(secretCiphertext)).toBe(true);
    expect(version.records[0]?.kek_id).toBe(rotated.newKekId);

    const oldRows = await primaryDb.db.executeQuery<{ count: string }>(
      `SELECT (
         (SELECT count(*) FROM secret_versions WHERE kek_id = :old) +
         (SELECT count(*) FROM certificate_versions WHERE kek_id = :old) +
         (SELECT count(*) FROM audit_keys WHERE kek_id = :old) +
         (SELECT count(*) FROM ca_keys WHERE kek_id = :old) +
         (SELECT count(*) FROM signing_keys WHERE kek_id = :old)
       )::text AS count`,
      { old: rotated.oldKekId },
    );
    expect(Number(oldRows.records[0]?.count)).toBe(0);

    const keyring = await KeyringProvider.load(keyringPath);
    try {
      expect(keyring.status().currentId).toBe(rotated.newKekId);
      expect(keyring.status().keyCount).toBe(1);
      const secret = await primaryDb.db.executeQuery<{
        readonly secret_id: string;
        readonly version_id: string;
        readonly kek_id: string;
        readonly nonce: Buffer;
        readonly tag: Buffer;
        readonly ciphertext: Buffer;
        readonly wrap_nonce: Buffer;
        readonly wrapped_dek: Buffer;
        readonly wrap_tag: Buffer;
        readonly project_id: string;
      }>(
        `SELECT s.id AS secret_id, v.id AS version_id, v.kek_id, v.nonce, v.tag, v.ciphertext,
                v.wrap_nonce, v.wrapped_dek, v.wrap_tag, s.project_id
           FROM secrets s JOIN secret_versions v ON v.id = s.current_version_id
          WHERE s.id = :id`,
        { id: secretId },
      );
      const row = secret.records[0];
      if (row === undefined) {
        throw new Error("missing rotated secret");
      }
      const plaintext = decryptValue(
        {
          kekId: row.kek_id,
          nonce: row.nonce.toString("base64"),
          tag: row.tag.toString("base64"),
          ciphertext: row.ciphertext.toString("base64"),
          wrapNonce: row.wrap_nonce.toString("base64"),
          wrappedDek: row.wrapped_dek.toString("base64"),
          wrapTag: row.wrap_tag.toString("base64"),
        },
        keyring,
        {
          objectType: "secret",
          projectId: row.project_id,
          objectId: row.secret_id,
          version: row.version_id,
        },
      );
      expect(plaintext.toString("utf8")).toBe("restore-me");
      plaintext.fill(0);
      const audit = await new AuditVerifier({
        database: primaryDb.db,
        keyring,
      }).verify();
      expect(audit.ok).toBe(true);

      const caSigner = await CaSigner.load({
        database: primaryDb.db,
        keyring,
        caPem: readFileSync(internalCaPath, "utf8"),
        now: Date.now,
      });
      try {
        await caSigner.issueServerCertificate({
          subject: "CN=post-rotate-probe",
          dnsNames: ["post-rotate-probe"],
          ipAddresses: [],
        });
      } finally {
        caSigner.destroy();
      }

      const signing = new SigningKeyService({
        repository: new SigningKeyRepository(primaryDb.db),
        keyring,
        now: Date.now,
      });
      try {
        const token = await signing.signAccessToken({
          principalId: adminId,
          familyId: newUlid(),
          nowMs: Date.now(),
        });
        await expect(signing.verifyAccessToken(token.token)).resolves.toMatchObject({
          sub: adminId,
        });
      } finally {
        signing.destroy();
      }
    } finally {
      keyring.destroy();
    }

    const second = await runKekRotate({ databaseUrl: primaryDb.url, keyringPath });
    expect(second.newKekId).not.toBe(rotated.newKekId);
    expect(second.newKekId).not.toBe(rotated.oldKekId);
    const secondKeyring = await KeyringProvider.load(keyringPath);
    try {
      expect(secondKeyring.status().currentId).toBe(second.newKekId);
      expect(secondKeyring.status().keyCount).toBe(1);
    } finally {
      secondKeyring.destroy();
    }
  });
});
