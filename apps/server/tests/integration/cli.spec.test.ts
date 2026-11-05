import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApplication } from "../../src/app.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import type {
  SecureWebApplication,
  TransportHandle,
} from "../../src/transport/secure-application.js";
import { TlsMaterial } from "../../src/transport/tls.js";
import { testUlid } from "./helpers/fixtures.js";
import { createServerEnvironment, type ServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

const TEST_PASSWORD = "correct horse battery staple";
const PHC_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$qYb6T7aRMEwwCoMgjHxVyA$lMIQ1sBU1g1jPAxArtXtKhKu6LGUbPvoyvEwXEFNpTc";
const BINARY = fileURLToPath(new URL("../../../cli/dist/main.js", import.meta.url));

function externalIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (
        String(entry.family) === "IPv4" &&
        !entry.internal &&
        !entry.address.startsWith("169.254.")
      ) {
        return entry.address;
      }
    }
  }
  return undefined;
}

const trustedHost = externalIpv4() ?? "127.0.0.1";

let testDb: TestDatabase;
let environment: ServerEnvironment;
let running: { readonly app: SecureWebApplication; readonly handle: TransportHandle };
let cliDirectory: string;
let baseUrl: string;
let email: string;

/**
 * Spawns the built CLI asynchronously.
 *
 * The server runs in this test process, so a synchronous spawn would block the
 * event loop and deadlock the TLS handshake. The helper writes the optional
 * stdin value, closes stdin, and waits for the child to exit.
 */
async function runOv(
  args: readonly string[],
  input?: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BINARY, ...args], {
      cwd: cliDirectory,
      env: {
        ...process.env,
        HOME: cliDirectory,
        XDG_CONFIG_HOME: join(cliDirectory, "config"),
        OPENVAULT_CA_FILE: environment.tls.caPath,
        OPENVAULT_URL: baseUrl,
        PATH: process.env.PATH ?? "",
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(input ?? "");
  });
}

beforeAll(async () => {
  expect(existsSync(BINARY), `build the CLI first: ${BINARY}`).toBe(true);
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  environment = createServerEnvironment(
    {
      OPENVAULT_DB_URL: testDb.url,
      OPENVAULT_PROXY_CIDRS: `127.0.0.1/32,::1/128,${trustedHost}/32`,
    },
    { extraIp: trustedHost },
  );
  const keyring = await KeyringProvider.load(environment.keyringPath);
  const tls = TlsMaterial.load(environment.config);
  const database = new PostgreSQLDatabase({
    ...environment.config.database,
    poolConfig: { connectionTimeoutMillis: 2_000 },
    enableGracefulShutdown: false,
  });
  const app = await createTestApplication(environment.config, { database, tls, keyring });
  const handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
  running = { app, handle };
  baseUrl = `https://${trustedHost}:${handle.adminPort}`;
  cliDirectory = mkdtempSync(join(tmpdir(), "openvault-cli-e2e-"));

  const userId = testUlid(1_001);
  email = `cli-e2e-${userId.toLowerCase()}@example.test`;
  await testDb.db.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', 'CLI E2E', :email, 'active')`,
    { id: userId, email },
  );
  await testDb.db.executeQuery(
    `INSERT INTO local_credentials (principal_id, password_hash, must_change)
     VALUES (:id, :hash, false)`,
    { id: userId, hash: PHC_HASH },
  );
  await testDb.db.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, 'org.admin', 'org', 'org', :principalId)`,
    { id: testUlid(1_002), principalId: userId },
  );
}, 60_000);

afterAll(async () => {
  await running?.handle.stop();
  environment?.cleanup();
  await testDb?.cleanup();
  if (cliDirectory !== undefined) {
    rmSync(cliDirectory, { recursive: true, force: true });
  }
});

describe("CLI against the real server", () => {
  it("should log in, create a project and secret, scaffold, verify audit, and doctor", async () => {
    const login = await runOv(
      ["login", "--url", baseUrl, "--identifier", email, "--password-stdin"],
      `${TEST_PASSWORD}\n`,
    );
    expect(login.status, login.stderr).toBe(0);
    const who = await runOv(["whoami", "--json"]);
    expect(who.status, who.stderr).toBe(0);
    expect(JSON.parse(who.stdout)).toMatchObject({ success: true });

    const project = `e2e-${Date.now().toString(36)}`;
    expect((await runOv(["project", "create", project])).status, "project create").toBe(0);
    const set = await runOv(
      ["secret", "set", "db-password", "--project", project, "--stdin"],
      "real-value",
    );
    expect(set.status, set.stderr).toBe(0);
    const get = await runOv(["secret", "get", "db-password", "--project", project]);
    expect(get.status).toBe(0);
    expect(get.stdout).toBe("real-value");

    const scaffold = await runOv([
      "docker",
      "scaffold",
      project,
      "api",
      "--secret",
      "db-password",
      "--compose-project",
      project,
    ]);
    expect(scaffold.status, scaffold.stderr).toBe(0);
    const compose = join(cliDirectory, `openvault.${project}.api.compose.yaml`);
    const manifest = join(cliDirectory, `openvault.${project}.api.manifest.yaml`);
    expect(existsSync(compose)).toBe(true);
    expect(existsSync(manifest)).toBe(true);
    expect(readFileSync(compose, "utf8")).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(readFileSync(manifest, "utf8")).not.toMatch(/[A-Za-z0-9_-]{43}/);

    expect((await runOv(["audit", "verify"])).status).toBe(0);
    const doctor = await runOv(["doctor", "--json"]);
    expect(doctor.status, doctor.stderr).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ success: true, data: { ok: true } });
    expect((await runOv(["logout"])).status).toBe(0);
    expect(existsSync(join(cliDirectory, "config", "openvault", "credentials.json"))).toBe(false);
  }, 60_000);

  it("should reject a wrong password with the authentication exit code", async () => {
    const login = await runOv(
      ["login", "--url", baseUrl, "--identifier", email, "--password-stdin"],
      "wrong password\n",
    );
    expect(login.status).toBe(3);
    expect(login.stderr).toContain("invalid_credentials");
  }, 30_000);
});
