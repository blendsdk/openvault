import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InitOptions, InitResult } from "@openvault/server/init";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type FakeVault, startFakeVault } from "./helpers/fake-vault.js";
import { createTestRuntime, readCredentials, type TestRuntime } from "./helpers/runtime.js";

let vault: FakeVault;
let runtime: TestRuntime;

async function login(): Promise<void> {
  const result = await runtime.run(
    ["login", "--identifier", "ada", "--password-stdin", "--url", vault.url.href],
    "correct-horse\n",
  );
  expect(result.code).toBe(0);
}

beforeAll(async () => {
  vault = await startFakeVault();
});

afterAll(async () => {
  await vault.close();
});

afterEach(() => {
  runtime?.cleanup();
});

describe("CLI commands against a real HTTPS vault", () => {
  it("should log in, store tokens securely, and report the user", async () => {
    runtime = createTestRuntime(vault);
    await login();
    const credential = readCredentials(runtime.credentialPath());
    expect(credential.baseUrl).toBe(vault.url.href);
    expect(credential.accessToken).toBe(vault.accessToken);
    expect(statSync(runtime.credentialPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(runtime.directory, "config", "openvault")).mode & 0o777).toBe(0o700);
    const who = await runtime.run(["whoami", "--json"]);
    expect(who.code).toBe(0);
    expect(JSON.parse(who.stdout)).toMatchObject({
      success: true,
      data: { user: { name: "Ada" } },
    });
  });

  it("should reject an empty password from stdin", async () => {
    runtime = createTestRuntime(vault);
    const result = await runtime.run(
      ["login", "--identifier", "ada", "--password-stdin", "--url", vault.url.href],
      "",
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("password is required");
    expect(existsSync(runtime.credentialPath())).toBe(false);
  });

  it("should create, list, and delete a project", async () => {
    runtime = createTestRuntime(vault);
    await login();
    expect((await runtime.run(["project", "create", "payments"])).code).toBe(0);
    const list = await runtime.run(["project", "list", "--json"]);
    expect(JSON.parse(list.stdout).data.projects).toHaveLength(1);
    expect((await runtime.run(["project", "delete", "payments", "--yes"])).code).toBe(0);
  });

  it("should set, read, list, version, and delete a secret without leaking the value", async () => {
    runtime = createTestRuntime(vault);
    await login();
    const set = await runtime.run(
      ["secret", "set", "db-password", "--project", "payments", "--stdin"],
      "s3cret",
    );
    expect(set.code).toBe(0);
    expect(set.stdout).not.toContain("s3cret");
    expect(
      vault.requests.some((request) => JSON.stringify(request.body ?? "").includes("s3cret")),
    ).toBe(true);
    const get = await runtime.run(["secret", "get", "db-password", "--project", "payments"]);
    expect(get.stdout).toBe("s3cret");
    const list = await runtime.run(["secret", "list", "--project", "payments", "--json"]);
    expect(JSON.parse(list.stdout).data.secrets).toHaveLength(1);
    const versions = await runtime.run([
      "secret",
      "versions",
      "db-password",
      "--project",
      "payments",
    ]);
    expect(versions.code).toBe(0);
    expect(
      (await runtime.run(["secret", "delete", "db-password", "--project", "payments", "--yes"]))
        .code,
    ).toBe(0);
  });

  it("should write a secret to a private output file", async () => {
    runtime = createTestRuntime(vault);
    await login();
    await runtime.run(
      ["secret", "set", "db-password", "--project", "payments", "--stdin"],
      "s3cret",
    );
    const out = join(runtime.directory, "value.txt");
    const result = await runtime.run([
      "secret",
      "get",
      "db-password",
      "--project",
      "payments",
      "--out",
      out,
    ]);
    expect(result.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("s3cret");
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it("should scaffold a service and never write the token into a file", async () => {
    runtime = createTestRuntime(vault);
    await login();
    await runtime.run(["project", "create", "payments"]);
    const result = await runtime.run([
      "docker",
      "scaffold",
      "payments",
      "api",
      "--secret",
      "db-password",
      "--compose-project",
      "payments",
    ]);
    expect(result.code).toBe(0);
    const compose = join(runtime.directory, "openvault.payments.api.compose.yaml");
    const manifest = join(runtime.directory, "openvault.payments.api.manifest.yaml");
    expect(existsSync(compose)).toBe(true);
    expect(existsSync(manifest)).toBe(true);
    expect(readFileSync(compose, "utf8")).not.toContain("J".repeat(43));
    expect(readFileSync(manifest, "utf8")).not.toContain("J".repeat(43));
    expect(result.stdout).toContain("J".repeat(43));
  });

  it("should verify the audit chain and exit 1 when it is broken", async () => {
    runtime = createTestRuntime(vault);
    await login();
    const good = await runtime.run(["audit", "verify"]);
    expect(good.code).toBe(0);
    vault.auditOk = false;
    const broken = await runtime.run(["audit", "verify"]);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain("first bad event");
    vault.auditOk = true;
  });

  it("should export NDJSON to a private file", async () => {
    runtime = createTestRuntime(vault);
    await login();
    const out = join(runtime.directory, "audit.ndjson");
    const result = await runtime.run(["audit", "export", "--out", out]);
    expect(result.code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("eventId");
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it("should run a child with delivered files and environment", async () => {
    runtime = createTestRuntime(vault);
    await login();
    await runtime.run(
      ["secret", "set", "db-password", "--project", "payments", "--stdin"],
      "s3cret",
    );
    const manifest = [
      "project: payments",
      "entries:",
      "  - name: db-password",
      "    file: db_password",
      "    env: DB_PASSWORD",
      "",
    ].join("\n");
    writeFileSync(join(runtime.directory, "openvault.run.yaml"), manifest);
    const output = join(runtime.directory, "child.json");
    const script = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({`,
      "file: fs.readFileSync(require('node:path').join(process.env.OPENVAULT_RUN_DIR, 'db_password'), 'utf8'),",
      "env: process.env.DB_PASSWORD,",
      "token: process.env.OPENVAULT_ACCESS_TOKEN,",
      "}));",
    ].join(" ");
    const result = await runtime.run([
      "run",
      "--project",
      "payments",
      "--",
      process.execPath,
      "-e",
      script,
    ]);
    expect(result.code).toBe(0);
    const child = JSON.parse(readFileSync(output, "utf8")) as Record<string, string | undefined>;
    expect(child.file).toBe("s3cret");
    expect(child.env).toBe("s3cret");
    expect(child.token).toBeUndefined();
    expect(existsSync(join(runtime.directory, "openvault.run.yaml"))).toBe(true);
  });

  it("should list and revoke CLI sessions", async () => {
    runtime = createTestRuntime(vault);
    await login();
    const list = await runtime.run(["auth", "sessions", "--json"]);
    expect(JSON.parse(list.stdout).data.sessions).toHaveLength(1);
    const denied = await runtime.run([
      "auth",
      "sessions",
      "--revoke",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ]);
    expect(denied.code).toBe(2);
    const revoked = await runtime.run([
      "auth",
      "sessions",
      "--revoke",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--yes",
    ]);
    expect(revoked.code).toBe(0);
  });

  it("should run doctor after login", async () => {
    runtime = createTestRuntime(vault);
    await login();
    const result = await runtime.run(["doctor", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ success: true, data: { ok: true } });
  });

  it("should remove a credential file even when the config directory is loose", async () => {
    runtime = createTestRuntime(vault);
    await login();
    chmodSync(join(runtime.directory, "config", "openvault"), 0o755);
    const result = await runtime.run(["logout"]);
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(runtime.credentialPath())).toBe(false);
  });

  it("should emit a value-free verbose request event", async () => {
    runtime = createTestRuntime(vault);
    await login();
    const result = await runtime.run(["whoami", "--verbose", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain('"event":"request"');
    expect(result.stderr).toContain('"path":"/v1/auth/cli/me"');
    expect(result.stderr).not.toContain(vault.accessToken);
  });

  it("should emit only an error envelope for a broken audit chain in JSON mode", async () => {
    runtime = createTestRuntime(vault);
    await login();
    vault.auditOk = false;
    const result = await runtime.run(["audit", "verify", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      success: false,
      error: { code: "audit_chain_broken" },
    });
    vault.auditOk = true;
  });

  it("should reject a duplicate tag and an oversized value file", async () => {
    runtime = createTestRuntime(vault);
    await login();
    const duplicate = await runtime.run(
      [
        "secret",
        "set",
        "db-password",
        "--project",
        "payments",
        "--stdin",
        "--tag",
        "env=prod",
        "--tag",
        "env=dev",
      ],
      "value",
    );
    expect(duplicate.code).toBe(2);
    expect(duplicate.stderr).toContain("Duplicate tag");

    const large = join(runtime.directory, "large.txt");
    writeFileSync(large, "x".repeat(70_000), "utf8");
    const oversized = await runtime.run([
      "secret",
      "set",
      "db-password",
      "--project",
      "payments",
      "--from-file",
      large,
    ]);
    expect(oversized.code).toBe(2);
  });

  it("should remove the credential file on logout", async () => {
    runtime = createTestRuntime(vault);
    await login();
    expect((await runtime.run(["logout"])).code).toBe(0);
    expect(existsSync(runtime.credentialPath())).toBe(false);
  });

  it("should explain access without reading a secret value", async () => {
    runtime = createTestRuntime(vault);
    await login();
    await runtime.run(
      ["secret", "set", "db-password", "--project", "payments", "--stdin"],
      "s3cret",
    );
    const result = await runtime.run([
      "access",
      "explain",
      "db-password",
      "--project",
      "payments",
      "--json",
    ]);
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout).data as { principals: unknown[] };
    expect(data.principals).toHaveLength(1);
  });

  it("should create an identity and issue a one-time join token", async () => {
    runtime = createTestRuntime(vault);
    await login();
    await runtime.run(["project", "create", "payments"]);
    expect((await runtime.run(["identity", "create", "api", "--project", "payments"])).code).toBe(
      0,
    );
    const token = await runtime.run([
      "identity",
      "join-token",
      "api",
      "--project",
      "payments",
      "--json",
    ]);
    expect(token.code).toBe(0);
    expect(JSON.parse(token.stdout).data.token).toHaveLength(43);
  });

  it("should grant and revoke a role", async () => {
    runtime = createTestRuntime(vault);
    await login();
    await runtime.run(["project", "create", "payments"]);
    await runtime.run(["identity", "create", "api", "--project", "payments"]);
    expect(
      (await runtime.run(["role", "grant", "api", "secrets.reader", "--project", "payments"])).code,
    ).toBe(0);
    expect(
      (
        await runtime.run([
          "role",
          "revoke",
          "api",
          "secrets.reader",
          "--project",
          "payments",
          "--yes",
        ])
      ).code,
    ).toBe(0);
  });

  it("should generate and read a certificate", async () => {
    runtime = createTestRuntime(vault);
    await login();
    const generated = await runtime.run([
      "cert",
      "generate",
      "api",
      "--project",
      "payments",
      "--subject",
      "CN=api",
      "--san",
      "DNS:api",
    ]);
    expect(generated.code).toBe(0);
    const read = await runtime.run(["cert", "get", "api", "--project", "payments"]);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain("BEGIN CERTIFICATE");
    const privateOut = join(runtime.directory, "api.key");
    const privateKey = await runtime.run([
      "cert",
      "get",
      "api",
      "--project",
      "payments",
      "--private-key",
      "--out",
      privateOut,
    ]);
    expect(privateKey.code).toBe(0);
    expect(statSync(privateOut).mode & 0o777).toBe(0o600);
  });

  it("should refresh once on 401 and persist the rotated access token", async () => {
    runtime = createTestRuntime(vault);
    await login();
    vault.rejectNextAuthorized = true;
    const who = await runtime.run(["whoami", "--json"]);
    expect(who.code, who.stderr).toBe(0);
    const credential = readCredentials(runtime.credentialPath());
    expect(credential.accessToken).toBe(`${vault.accessToken}-2`);
    expect(vault.requests.some((request) => request.path === "/v1/auth/cli/refresh")).toBe(true);
  });

  it("should report a missing project with the not-found exit code", async () => {
    runtime = createTestRuntime(vault);
    await login();
    const missing = await runtime.run(["project", "delete", "missing", "--yes"]);
    expect(missing.code).toBe(5);
    expect(missing.stderr).toContain("project_not_found");
  });

  it("should require --out before reading a private key", async () => {
    runtime = createTestRuntime(vault);
    await login();
    const result = await runtime.run([
      "cert",
      "get",
      "api",
      "--project",
      "payments",
      "--private-key",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--out");
  });

  it("should preserve an existing audit export unless --force is set", async () => {
    runtime = createTestRuntime(vault);
    await login();
    const out = join(runtime.directory, "audit.ndjson");
    writeFileSync(out, "original\n", "utf8");
    const denied = await runtime.run(["audit", "export", "--out", out]);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("file_exists");
    expect(readFileSync(out, "utf8")).toBe("original\n");

    vault.auditExportFails = true;
    const failed = await runtime.run(["audit", "export", "--out", out, "--force"]);
    expect(failed.code).toBe(4);
    expect(failed.stderr).toContain("access_denied");
    expect(readFileSync(out, "utf8")).toBe("original\n");
    vault.auditExportFails = false;

    const forced = await runtime.run(["audit", "export", "--out", out, "--force"]);
    expect(forced.code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("eventId");
  });

  it("should resolve the audit --project filter to a project id", async () => {
    runtime = createTestRuntime(vault);
    await login();
    await runtime.run(["project", "create", "payments"]);
    const result = await runtime.run(["audit", "list", "--project", "payments", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const request = vault.requests.find((entry) => entry.path === "/v1/audit/events");
    expect(request?.query).toContain("projectId=");
  });

  it("should refresh and retry an audit export rejected once", async () => {
    runtime = createTestRuntime(vault);
    await login();
    vault.rejectNextAuthorized = true;
    const out = join(runtime.directory, "audit-refresh.ndjson");
    const result = await runtime.run(["audit", "export", "--out", out]);
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("eventId");
    expect(vault.requests.some((request) => request.path === "/v1/auth/cli/refresh")).toBe(true);
  });

  it("should set a secret from a file and reject a directory", async () => {
    runtime = createTestRuntime(vault);
    await login();
    const valueFile = join(runtime.directory, "value.txt");
    writeFileSync(valueFile, "from-file-secret", "utf8");
    const set = await runtime.run([
      "secret",
      "set",
      "db-password",
      "--project",
      "payments",
      "--from-file",
      valueFile,
    ]);
    expect(set.code, set.stderr).toBe(0);
    const read = await runtime.run(["secret", "get", "db-password", "--project", "payments"]);
    expect(read.stdout).toBe("from-file-secret");
    const directory = await runtime.run([
      "secret",
      "set",
      "db-password",
      "--project",
      "payments",
      "--from-file",
      runtime.directory,
    ]);
    expect(directory.code).toBe(2);
  });

  it("should abort before the child when a required run secret is missing", async () => {
    runtime = createTestRuntime(vault);
    await login();
    writeFileSync(
      join(runtime.directory, "openvault.run.yaml"),
      ["project: payments", "entries:", "  - name: missing", "    env: MISSING", ""].join("\n"),
      "utf8",
    );
    const marker = join(runtime.directory, "child-ran");
    const result = await runtime.run([
      "run",
      "--project",
      "payments",
      "--",
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("secret_not_found");
    expect(existsSync(marker)).toBe(false);
  });

  it("should run when an optional secret is missing and exit with the child code", async () => {
    runtime = createTestRuntime(vault);
    await login();
    await runtime.run(
      ["secret", "set", "db-password", "--project", "payments", "--stdin"],
      "s3cret",
    );
    writeFileSync(
      join(runtime.directory, "openvault.run.yaml"),
      [
        "project: payments",
        "entries:",
        "  - name: db-password",
        "    env: DB_PASSWORD",
        "  - name: optional-missing",
        "    env: OPTIONAL",
        "    optional: true",
        "",
      ].join("\n"),
      "utf8",
    );
    const output = join(runtime.directory, "child.json");
    const script = `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({ env: process.env.DB_PASSWORD, optional: process.env.OPTIONAL ?? null })); process.exit(7);`;
    const result = await runtime.run([
      "run",
      "--project",
      "payments",
      "--",
      process.execPath,
      "-e",
      script,
    ]);
    expect(result.code).toBe(7);
    expect(result.stderr).toContain("optional-missing");
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ env: "s3cret", optional: null });
  });

  it("should map --prepare and environment values into bootstrap options", async () => {
    let captured: InitOptions | undefined;
    runtime = createTestRuntime(vault, {
      runInit: async (options: InitOptions): Promise<InitResult> => {
        captured = options;
        return {
          keyringCreated: true,
          caCreated: true,
          serverCertificateCreated: true,
          adminCreated: true,
          orgCreated: true,
          signingKeyCreated: true,
          internalCaPath: options.internalCaPath ?? "/tmp/ca.pem",
          warnings: [],
        };
      },
    });
    runtime.env.OPENVAULT_DB_URL = "postgres://user:pass@localhost:5432/openvault";
    runtime.env.OPENVAULT_KEYRING = join(runtime.directory, "keyring.json");
    runtime.env.OPENVAULT_TLS_CERT = join(runtime.directory, "server.crt");
    runtime.env.OPENVAULT_TLS_KEY = join(runtime.directory, "server.key");
    runtime.env.OPENVAULT_INTERNAL_CA = join(runtime.directory, "ca.pem");
    const result = await runtime.run(["init", "--prepare"]);
    expect(result.code, result.stderr).toBe(0);
    expect(captured?.generatePassword).toBe(true);
    expect(captured?.databaseUrl).toBe("postgres://user:pass@localhost:5432/openvault");
    expect(captured?.keyringPath).toBe(join(runtime.directory, "keyring.json"));
    expect(result.stdout).toContain("keyring: created");
  });

  it("should print one JSON result and exit 1 when doctor cannot check a server", async () => {
    runtime = createTestRuntime(vault);
    delete runtime.env.OPENVAULT_URL;
    const result = await runtime.run(["doctor", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ success: true, data: { ok: false } });
  });

  it("should reject an unknown completion shell", async () => {
    runtime = createTestRuntime(vault);
    const result = await runtime.run(["completion", "tcsh"]);
    expect(result.code).toBe(2);
  });

  it("should map backup options and require a non-interactive passphrase", async () => {
    let captured: Record<string, unknown> | undefined;
    runtime = createTestRuntime(vault, {
      runBackup: async (options) => {
        captured = options as unknown as Record<string, unknown>;
        return {
          outPath: options.outPath,
          bytes: 10,
          sha256: "a".repeat(64),
          createdAt: "2026-11-05T12:00:00.000Z",
          objectCount: 1,
          tables: ["secrets"],
        };
      },
    });
    runtime.env.OPENVAULT_DB_URL = "postgres://user:pass@localhost:5432/db";
    runtime.env.OPENVAULT_KEYRING = join(runtime.directory, "keyring.json");
    runtime.env.OPENVAULT_INTERNAL_CA = join(runtime.directory, "ca.pem");
    const passphrase = join(runtime.directory, "passphrase.txt");
    writeFileSync(passphrase, "correct horse battery staple\n", { mode: 0o600 });
    chmodSync(passphrase, 0o600);
    const out = join(runtime.directory, "backup.age");
    const result = await runtime.run([
      "backup",
      "--out",
      out,
      "--passphrase-file",
      passphrase,
      "--force",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(captured?.passphrase).toBe("correct horse battery staple");
    expect(captured?.outPath).toBe(out);
    expect(captured?.force).toBe(true);
    expect(result.stdout).toContain("Wrote");

    const missing = await runtime.run(["backup", "--out", out]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("passphrase");
  });

  it("should gate restore and KEK rotation and call the injected operations", async () => {
    let restored = false;
    let rotated = false;
    runtime = createTestRuntime(vault, {
      runRestore: async (options) => {
        restored = true;
        return {
          objectCount: 2,
          tables: ["projects", "secrets"],
          auditOk: true,
          secretsVerified: 1,
          caVerified: true,
          internalCaPath: options.internalCaPath,
        };
      },
      runKekRotate: async () => {
        rotated = true;
        return {
          oldKekId: "kek-1",
          newKekId: "kek-2",
          counts: {
            secretVersions: 1,
            certificateVersions: 0,
            auditKeys: 1,
            caKeys: 1,
            signingKeys: 1,
          },
          dryRun: false,
          oldKeyRemoved: true,
        };
      },
    });
    runtime.env.OPENVAULT_DB_URL = "postgres://user:pass@localhost:5432/db";
    runtime.env.OPENVAULT_KEYRING = join(runtime.directory, "keyring.json");
    runtime.env.OPENVAULT_INTERNAL_CA = join(runtime.directory, "ca.pem");
    const passphrase = join(runtime.directory, "passphrase.txt");
    writeFileSync(passphrase, "correct horse battery staple\n", { mode: 0o600 });
    chmodSync(passphrase, 0o600);

    const denied = await runtime.run([
      "restore",
      join(runtime.directory, "backup.age"),
      "--passphrase-file",
      passphrase,
    ]);
    expect(denied.code).toBe(2);
    expect(restored).toBe(false);

    const accepted = await runtime.run([
      "restore",
      join(runtime.directory, "backup.age"),
      "--passphrase-file",
      passphrase,
      "--yes",
    ]);
    expect(accepted.code, accepted.stderr).toBe(0);
    expect(restored).toBe(true);

    const rotateDenied = await runtime.run(["kek", "rotate"]);
    expect(rotateDenied.code).toBe(2);
    expect(rotated).toBe(false);
    const rotateAccepted = await runtime.run(["kek", "rotate", "--yes"]);
    expect(rotateAccepted.code, rotateAccepted.stderr).toBe(0);
    expect(rotated).toBe(true);
    expect(rotateAccepted.stdout).toContain("kek-2");
    const dryRun = await runtime.run(["kek", "rotate", "--dry-run"]);
    expect(dryRun.code, dryRun.stderr).toBe(0);
  });

  it("should explain certificate and project access", async () => {
    runtime = createTestRuntime(vault);
    await login();
    await runtime.run(["project", "create", "payments"]);
    await runtime.run([
      "cert",
      "generate",
      "api",
      "--project",
      "payments",
      "--subject",
      "CN=api",
      "--san",
      "DNS:api",
    ]);
    const certificate = await runtime.run([
      "access",
      "explain",
      "api",
      "--project",
      "payments",
      "--target-type",
      "certificate",
      "--json",
    ]);
    expect(certificate.code, certificate.stderr).toBe(0);
    expect(JSON.parse(certificate.stdout).data.principals).toHaveLength(1);
    const project = await runtime.run([
      "access",
      "explain",
      "payments",
      "--target-type",
      "project",
      "--json",
    ]);
    expect(project.code, project.stderr).toBe(0);
  });

  it("should list and delete a certificate", async () => {
    runtime = createTestRuntime(vault);
    await login();
    await runtime.run([
      "cert",
      "generate",
      "api",
      "--project",
      "payments",
      "--subject",
      "CN=api",
      "--san",
      "DNS:api",
    ]);
    const list = await runtime.run(["cert", "list", "--project", "payments", "--json"]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout).data.certificates).toHaveLength(1);
    const deleted = await runtime.run(["cert", "delete", "api", "--project", "payments", "--yes"]);
    expect(deleted.code).toBe(0);
  });
});
