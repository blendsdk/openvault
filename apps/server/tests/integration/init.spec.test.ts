import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassword } from "../../src/auth/password.js";
import { runInit } from "../../src/init/index.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;
const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openvault-init-"));
  directories.push(directory);
  return directory;
}

async function options(directory: string, email: string): Promise<Parameters<typeof runInit>[0]> {
  return {
    databaseUrl: testDb.url,
    migrationDatabaseUrl: testDb.url,
    keyringPath: join(directory, "keyring.json"),
    internalCaPath: join(directory, "ca.pem"),
    tlsCertPath: join(directory, "server.crt"),
    tlsKeyPath: join(directory, "server.key"),
    baseUrl: "https://localhost",
    orgName: "Acme",
    adminName: "Ada Admin",
    adminEmail: email,
    generatePassword: true,
    bootstrapPasswordFile: join(directory, "bootstrap-password.txt"),
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
}, 60_000);

afterAll(async () => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  await testDb?.cleanup();
});

describe("bootstrap init", () => {
  it("should create the keyring, CA, TLS pair, organization, admin, and signing key idempotently", async () => {
    const directory = tempDirectory();
    const first = await runInit(await options(directory, "ada@example.test"));
    expect(first.keyringCreated).toBe(true);
    expect(first.caCreated).toBe(true);
    expect(first.serverCertificateCreated).toBe(true);
    expect(first.adminCreated).toBe(true);
    // The migration seeds the organization row; init may reuse it.
    expect(typeof first.orgCreated).toBe("boolean");
    expect(first.signingKeyCreated).toBe(true);
    expect(first.bootstrapPasswordFile).toBe(join(directory, "bootstrap-password.txt"));
    expect(statSync(join(directory, "keyring.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, "ca.pem")).mode & 0o777).toBe(0o644);
    expect(statSync(join(directory, "server.crt")).mode & 0o777).toBe(0o644);
    expect(statSync(join(directory, "server.key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, "bootstrap-password.txt")).mode & 0o777).toBe(0o600);

    const keyringBefore = readFileSync(join(directory, "keyring.json"), "utf8");
    const caBefore = readFileSync(join(directory, "ca.pem"), "utf8");
    const passwordBefore = readFileSync(join(directory, "bootstrap-password.txt"), "utf8");
    const caCertificate = new X509Certificate(caBefore);
    expect(
      new X509Certificate(readFileSync(join(directory, "server.crt"), "utf8")).checkIssued(
        caCertificate,
      ),
    ).toBe(true);

    const admin = await testDb.db.executeQuery<{ id: string }>(
      "SELECT id FROM principals WHERE kind = 'user' AND email = :email",
      { email: "ada@example.test" },
    );
    expect(admin.records).toHaveLength(1);
    const credential = await testDb.db.executeQuery<{
      password_hash: string;
      must_change: boolean;
    }>("SELECT password_hash, must_change FROM local_credentials WHERE principal_id = :id", {
      id: admin.records[0]?.id,
    });
    expect(credential.records[0]?.must_change).toBe(false);
    expect(
      await verifyPassword(passwordBefore.trim(), credential.records[0]?.password_hash ?? ""),
    ).toBe(true);
    const org = await testDb.db.executeQuery<{ name: string }>("SELECT name FROM org WHERE id = 1");
    expect(org.records[0]?.name).toBe("Acme");
    const assignments = await testDb.db.executeQuery<{ count: string }>(
      "SELECT count(*) AS count FROM role_assignments WHERE principal_id = :id AND role = 'org.admin'",
      { id: admin.records[0]?.id },
    );
    expect(Number(assignments.records[0]?.count)).toBe(1);

    const second = await runInit(await options(directory, "ada@example.test"));
    expect(second.keyringCreated).toBe(false);
    expect(second.caCreated).toBe(false);
    expect(second.serverCertificateCreated).toBe(false);
    expect(second.adminCreated).toBe(false);
    expect(second.orgCreated).toBe(false);
    expect(second.signingKeyCreated).toBe(false);
    expect(readFileSync(join(directory, "keyring.json"), "utf8")).toBe(keyringBefore);
    expect(readFileSync(join(directory, "ca.pem"), "utf8")).toBe(caBefore);
    expect(readFileSync(join(directory, "bootstrap-password.txt"), "utf8")).toBe(passwordBefore);
  }, 60_000);

  it("should converge when two init processes run concurrently", async () => {
    const concurrentDb = await createTestDatabase();
    await applyMigrations(concurrentDb);
    const directory = tempDirectory();
    const shared = {
      ...(await options(directory, "concurrent@example.test")),
      databaseUrl: concurrentDb.url,
      migrationDatabaseUrl: concurrentDb.url,
    };
    try {
      const [first, second] = await Promise.all([runInit(shared), runInit(shared)]);
      expect([first.keyringCreated, second.keyringCreated].filter(Boolean)).toHaveLength(1);
      expect([first.caCreated, second.caCreated].filter(Boolean)).toHaveLength(1);
      expect(
        [first.serverCertificateCreated, second.serverCertificateCreated].filter(Boolean),
      ).toHaveLength(1);
      expect([first.adminCreated, second.adminCreated].filter(Boolean)).toHaveLength(1);
      expect([first.signingKeyCreated, second.signingKeyCreated].filter(Boolean)).toHaveLength(1);
      expect(statSync(join(directory, "bootstrap-password.txt")).mode & 0o777).toBe(0o600);

      const caCount = await concurrentDb.db.executeQuery<{ count: string }>(
        "SELECT count(*) AS count FROM ca_keys WHERE status = 'current'",
      );
      expect(Number(caCount.records[0]?.count)).toBe(1);
      const adminCount = await concurrentDb.db.executeQuery<{ count: string }>(
        "SELECT count(*) AS count FROM principals WHERE kind = 'user' AND email = :email",
        { email: "concurrent@example.test" },
      );
      expect(Number(adminCount.records[0]?.count)).toBe(1);
      const assignmentCount = await concurrentDb.db.executeQuery<{ count: string }>(
        "SELECT count(*) AS count FROM role_assignments WHERE role = 'org.admin' AND principal_id IN (SELECT id FROM principals WHERE email = :email)",
        { email: "concurrent@example.test" },
      );
      expect(Number(assignmentCount.records[0]?.count)).toBe(1);
      const signingCount = await concurrentDb.db.executeQuery<{ count: string }>(
        "SELECT count(*) AS count FROM signing_keys",
      );
      expect(Number(signingCount.records[0]?.count)).toBe(1);
    } finally {
      await concurrentDb.cleanup();
    }
  }, 120_000);

  it("should fail closed when the keyring is missing but wrapped state exists", async () => {
    const recoveryDb = await createTestDatabase();
    await applyMigrations(recoveryDb);
    const directory = tempDirectory();
    const shared = {
      ...(await options(directory, "grace@example.test")),
      databaseUrl: recoveryDb.url,
      migrationDatabaseUrl: recoveryDb.url,
    };
    try {
      await runInit(shared);
      rmSync(join(directory, "keyring.json"));
      await expect(runInit(shared)).rejects.toMatchObject({
        code: "init_recovery_required",
      });
      expect(existsSync(join(directory, "keyring.json"))).toBe(false);
    } finally {
      await recoveryDb.cleanup();
    }
  }, 120_000);

  it("should reject a one-sided TLS pair before writing a keyring", async () => {
    const directory = tempDirectory();
    const shared = await options(directory, "tls@example.test");
    const { tlsKeyPath: _tlsKeyPath, ...oneSided } = shared;
    await expect(runInit(oneSided)).rejects.toMatchObject({ code: "init_configuration" });
    expect(existsSync(join(directory, "keyring.json"))).toBe(false);
  }, 30_000);

  it("should reject an operator password shorter than 12 characters", async () => {
    const passwordDb = await createTestDatabase();
    await applyMigrations(passwordDb);
    const directory = tempDirectory();
    const passwordFile = join(directory, "password.txt");
    writeFileSync(passwordFile, "short", { mode: 0o600 });
    chmodSync(passwordFile, 0o600);
    try {
      const base = await options(directory, "short@example.test");
      const { bootstrapPasswordFile: _bootstrapPasswordFile, ...withoutPasswordFile } = base;
      await expect(
        runInit({
          ...withoutPasswordFile,
          databaseUrl: passwordDb.url,
          migrationDatabaseUrl: passwordDb.url,
          generatePassword: false,
          passwordFile,
        }),
      ).rejects.toMatchObject({ code: "init_password" });
      const admins = await passwordDb.db.executeQuery<{ count: string }>(
        "SELECT count(*) AS count FROM principals WHERE email = :email",
        { email: "short@example.test" },
      );
      expect(Number(admins.records[0]?.count)).toBe(0);
    } finally {
      await passwordDb.cleanup();
    }
  }, 120_000);

  it("should fail closed when the public CA file differs from the stored CA", async () => {
    const caDb = await createTestDatabase();
    await applyMigrations(caDb);
    const directory = tempDirectory();
    const caPath = join(directory, "ca.pem");
    writeFileSync(caPath, "different\n", { mode: 0o644 });
    chmodSync(caPath, 0o644);
    try {
      await expect(
        runInit({
          ...(await options(directory, "ca@example.test")),
          databaseUrl: caDb.url,
          migrationDatabaseUrl: caDb.url,
          internalCaPath: caPath,
          generatePassword: true,
        }),
      ).rejects.toMatchObject({ code: "init_insecure" });
      expect(readFileSync(caPath, "utf8")).toBe("different\n");
    } finally {
      await caDb.cleanup();
    }
  }, 120_000);

  it("should reject a FIFO password file without blocking", async () => {
    const fifoDb = await createTestDatabase();
    await applyMigrations(fifoDb);
    const directory = tempDirectory();
    const fifo = join(directory, "password.fifo");
    execFileSync("mkfifo", [fifo]);
    try {
      const base = await options(directory, "fifo@example.test");
      const { bootstrapPasswordFile: _bootstrapPasswordFile, ...withoutPasswordFile } = base;
      await expect(
        runInit({
          ...withoutPasswordFile,
          databaseUrl: fifoDb.url,
          migrationDatabaseUrl: fifoDb.url,
          generatePassword: false,
          passwordFile: fifo,
        }),
      ).rejects.toMatchObject({ code: "init_password" });
    } finally {
      await fifoDb.cleanup();
    }
  }, 120_000);

  it("should replace a public CA file when --replace-ca-public is set", async () => {
    const replaceDb = await createTestDatabase();
    await applyMigrations(replaceDb);
    const directory = tempDirectory();
    const caPath = join(directory, "ca.pem");
    writeFileSync(caPath, "old\n", { mode: 0o600 });
    chmodSync(caPath, 0o600);
    try {
      const result = await runInit({
        ...(await options(directory, "replace@example.test")),
        databaseUrl: replaceDb.url,
        migrationDatabaseUrl: replaceDb.url,
        internalCaPath: caPath,
        replaceCaPublic: true,
      });
      expect(result.caCreated).toBe(true);
      expect(readFileSync(caPath, "utf8")).toContain("BEGIN CERTIFICATE");
      expect(statSync(caPath).mode & 0o777).toBe(0o644);
    } finally {
      await replaceDb.cleanup();
    }
  }, 120_000);

  it("should reject an insecure keyring file", async () => {
    const directory = tempDirectory();
    const keyring = JSON.stringify({
      version: 1,
      current: "kek-1",
      keys: { "kek-1": Buffer.alloc(32, 1).toString("base64") },
    });
    writeFileSync(join(directory, "keyring.json"), keyring, { mode: 0o644 });
    chmodSync(join(directory, "keyring.json"), 0o644);
    await expect(runInit(await options(directory, "linus@example.test"))).rejects.toThrow(
      /0600|mode/i,
    );
  }, 60_000);
});
