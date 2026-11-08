import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const example = join(root, "examples/compose-env");
const composePath = join(example, "compose.yaml");
const manifestPath = join(example, "manifest.yaml");
const loaderPath = join(example, "loader.sh");
const runPath = join(example, "run.sh");
const envMapPath = join(example, "env.map");
const envExamplePath = join(example, ".env.example");

const fixtures = [];

function read(path) {
  return readFileSync(path, "utf8");
}

function makeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "openvault-loader-"));
  fixtures.push(directory);
  return directory;
}

function runLoader(directory, args, extraEnv = {}) {
  return spawnSync("sh", [loaderPath, ...args], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENVAULT_ENV_MAP: join(directory, "env.map"),
      OPENVAULT_SECRET_DIR: join(directory, "secrets"),
      ...extraEnv,
    },
  });
}

function writeMap(directory, content) {
  writeFileSync(join(directory, "env.map"), content);
}

function writeSecret(directory, name, value) {
  writeFileSync(join(directory, "secrets", name), value);
}

function prepareFixture() {
  const directory = makeFixture();
  const secrets = join(directory, "secrets");
  // mkdtempSync already made the parent; create the secret directory and map.
  spawnSync("mkdir", ["-p", secrets]);
  writeMap(directory, "APP_API_TOKEN=api-token\n");
  writeSecret(directory, "api-token", "s3cr3t-value\n");
  return directory;
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("environment-variable example", () => {
  it("should keep the example services hardened and non-root", () => {
    const compose = parse(read(composePath));

    for (const [name, service] of Object.entries(compose.services)) {
      expect(service.read_only, name).toBe(true);
      expect(service.cap_drop, name).toContain("ALL");
      expect(service.security_opt, name).toContain("no-new-privileges:true");
      expect(service.user, name).toMatch(/^10001:10001$/);
      expect(service.ports ?? [], name).toEqual([]);
      expect(service.logging?.options?.["max-size"], name).toBe("10m");
      expect(service.deploy?.resources?.limits, name).toBeTruthy();
    }
  });

  it("should pin the agent release and the application base image", () => {
    const compose = parse(read(composePath));

    expect(compose.services["openvault-agent-api"].image).toBe("blendsdk/openvault-agent:1.0.1");
    expect(compose.services["openvault-agent-api"].command).toEqual(["run"]);
    expect(compose.services.api.image).toMatch(/^alpine:3\.21@sha256:[0-9a-f]{64}$/);
  });

  it("should share the agent tmpfs with the application loader", () => {
    const compose = parse(read(composePath));
    const agent = compose.services["openvault-agent-api"];
    const app = compose.services.api;
    const agentOutput = agent.volumes.find((volume) => volume.target === "/run/secrets");
    const appOutput = app.volumes.find((volume) => volume.target === "/run/secrets");

    expect(agentOutput.source).toContain("/dev/shm/openvault/quickstart/");
    expect(agentOutput.source).toMatch(/\$\{COMPOSE_PROJECT_NAME\}/);
    expect(appOutput.source).toBe(agentOutput.source);
    expect(appOutput.read_only).toBe(true);
    expect(app.entrypoint).toEqual(["/bin/sh", "/opt/openvault/load-env.sh"]);
    expect(app.depends_on["openvault-agent-api"].condition).toBe("service_healthy");
    expect(agent.healthcheck.test).toEqual(["CMD", "ov-agent", "health", "--ready"]);
    expect(agent.healthcheck.timeout).toBe("10s");
    expect(agent.healthcheck.start_period).toBe("10s");
  });

  it("should join the reference stack network by its explicit name", () => {
    const compose = parse(read(composePath));

    expect(compose.networks.vault_net.external).toBe(true);
    expect(compose.networks.vault_net.name).toBe("vault_net");
    expect(compose.services["openvault-agent-api"].networks).toContain("vault_net");
    expect(compose.services.api.ports).toBeUndefined();
  });

  it("should map the manifest entry to the environment variable", () => {
    const manifest = parse(read(manifestPath));
    const map = read(envMapPath)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    expect(manifest.project).toBe("quickstart");
    expect(manifest.service).toBe("api");
    expect(manifest.output_dir).toBe("/run/secrets");
    expect(manifest.entries).toEqual([{ name: "api-token", file: "api-token" }]);
    expect(map).toEqual(["APP_API_TOKEN=api-token"]);
  });

  it("should leave the join token out of the example and ignore the real .env", () => {
    const envExample = read(envExamplePath);
    const gitignore = read(join(root, ".gitignore"));

    expect(envExample).toContain("OPENVAULT_JOIN_TOKEN=\n");
    expect(envExample).not.toMatch(/OPENVAULT_JOIN_TOKEN=.+/);
    expect(gitignore).toMatch(/^\.env$/m);
    expect(gitignore).toContain("examples/compose-env/openvault-ca.pem");
  });

  it("should keep the helper scripts executable and syntactically valid", () => {
    for (const path of [loaderPath, runPath]) {
      expect(statSync(path).mode & 0o111, path).not.toBe(0);
      const checked = spawnSync("sh", ["-n", path], { cwd: example, encoding: "utf8" });
      expect(checked.status, checked.stderr).toBe(0);
    }
  });
});

describe("environment-variable loader", () => {
  it("should export the secret and exec the command", () => {
    const directory = prepareFixture();
    const result = runLoader(directory, [
      "sh",
      "-c",
      'test "$APP_API_TOKEN" = "s3cr3t-value" && printf exported',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("exported");
    expect(result.stderr).not.toContain("s3cr3t-value");
  });

  it("should require a command", () => {
    const directory = prepareFixture();
    const result = runLoader(directory, []);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no command");
  });

  it("should reject an unsafe environment name", () => {
    const directory = prepareFixture();
    writeMap(directory, "BAD-NAME=api-token\n");

    const result = runLoader(directory, ["true"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid environment name");
  });

  it("should reject a path outside the secret directory", () => {
    const directory = prepareFixture();
    writeMap(directory, "APP_API_TOKEN=../outside\n");

    const result = runLoader(directory, ["true"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid secret file");
  });

  it("should reject a symlink in the secret directory", () => {
    const directory = prepareFixture();
    symlinkSync(join(directory, "secrets", "api-token"), join(directory, "secrets", "link"));

    writeMap(directory, "APP_API_TOKEN=link\n");
    const result = runLoader(directory, ["true"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing regular secret file");
  });

  it("should reject a missing secret file", () => {
    const directory = prepareFixture();
    writeMap(directory, "APP_API_TOKEN=missing\n");

    const result = runLoader(directory, ["true"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing regular secret file");
  });
});
