import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { VaultClient } from "../src/client.js";
import { loadAgentConfig } from "../src/config.js";
import { joinAgent } from "../src/join.js";
import { createAgentLogger, silentAgentLogger } from "../src/logger.js";
import { loadAgentManifest } from "../src/manifest.js";
import { AgentRunner } from "../src/runner.js";
import { AgentStateStore } from "../src/state.js";
import { startFakeVault } from "./helpers/fake-vault.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function wrapperManifest(directory: string): string {
  const path = join(directory, "manifest.yaml");
  writeFileSync(
    path,
    `project: payments
service: api
output_dir: ${join(directory, "out")}
entries:
  - name: db-password
    file: db_password
    env: DB_PASSWORD
`,
  );
  return path;
}

describe("wrapper mode and logging", () => {
  it("should export only manifest env entries and remove OPENVAULT_* from the child", async () => {
    const fake = await startFakeVault();
    cleanups.push(() => fake.close());
    fake.values.set("db-password", { value: "wrapper-secret", encoding: "utf8" });
    const directory = mkdtempSync(join(tmpdir(), "openvault-agent-wrapper-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const manifestFile = wrapperManifest(directory);
    const env: NodeJS.ProcessEnv = {
      OPENVAULT_URL: fake.url.href,
      OPENVAULT_CA_FILE: fake.caPath,
      OPENVAULT_JOIN_TOKEN: "A".repeat(43),
      OPENVAULT_PROJECT: "payments",
      OPENVAULT_SERVICE: "api",
      COMPOSE_PROJECT_NAME: "payments",
      OPENVAULT_MANIFEST: manifestFile,
      OPENVAULT_OUTPUT_DIR: join(directory, "out"),
      OPENVAULT_STATE_DIR: join(directory, "state"),
      OPENVAULT_STATUS_FILE: join(directory, "status.json"),
      OPENVAULT_SOCKET_PATH: join(directory, "agent.sock"),
    };
    const config = loadAgentConfig(env);
    const manifest = loadAgentManifest(config.manifestPath, {
      project: config.project,
      service: config.service,
      outputDir: config.outputDir,
      mode: "wrapper",
    });
    const output = join(directory, "child-env.txt");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify({ secret: process.env.DB_PASSWORD, token: process.env.OPENVAULT_JOIN_TOKEN, project: process.env.OPENVAULT_PROJECT }))`;
    process.env.OPENVAULT_JOIN_TOKEN = "A".repeat(43);
    cleanups.push(() => {
      delete process.env.OPENVAULT_JOIN_TOKEN;
    });
    const runner = new AgentRunner({
      config,
      manifest,
      store: new AgentStateStore(config.stateDir),
      logger: silentAgentLogger,
      wrapper: { command: process.execPath, args: ["-e", script] },
    });
    const code = await runner.run();
    expect(code).toBe(0);
    const child = JSON.parse(readFileSync(output, "utf8")) as Record<string, string | undefined>;
    expect(child.secret).toBe("wrapper-secret");
    expect(child.token).toBeUndefined();
    expect(child.project).toBeUndefined();
  });

  it("should never log a delivered value", async () => {
    const fake = await startFakeVault();
    cleanups.push(() => fake.close());
    fake.values.set("db-password", { value: "SENTINEL_VALUE_DO_NOT_LOG", encoding: "utf8" });
    const directory = mkdtempSync(join(tmpdir(), "openvault-agent-log-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const manifestFile = join(directory, "manifest.yaml");
    writeFileSync(
      manifestFile,
      `project: payments
service: api
output_dir: ${join(directory, "out")}
entries:
  - name: db-password
    file: db_password
`,
    );
    const env: NodeJS.ProcessEnv = {
      OPENVAULT_URL: fake.url.href,
      OPENVAULT_CA_FILE: fake.caPath,
      OPENVAULT_JOIN_TOKEN: "A".repeat(43),
      OPENVAULT_PROJECT: "payments",
      OPENVAULT_SERVICE: "api",
      COMPOSE_PROJECT_NAME: "payments",
      OPENVAULT_MANIFEST: manifestFile,
      OPENVAULT_OUTPUT_DIR: join(directory, "out"),
      OPENVAULT_STATE_DIR: join(directory, "state"),
      OPENVAULT_STATUS_FILE: join(directory, "status.json"),
      OPENVAULT_SOCKET_PATH: join(directory, "agent.sock"),
    };
    const config = loadAgentConfig(env);
    const manifest = loadAgentManifest(config.manifestPath, {
      project: config.project,
      service: config.service,
      outputDir: config.outputDir,
      mode: "sidecar",
    });
    const store = new AgentStateStore(config.stateDir);
    const client = new VaultClient({
      baseUrl: config.url,
      caPem: readFileSync(config.caFile, "utf8"),
    });
    const joined = await joinAgent({
      config,
      manifest,
      store,
      client,
      logger: silentAgentLogger,
    });
    const chunks: string[] = [];
    const logger = createAgentLogger(
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      }),
    );
    const { Delivery } = await import("../src/delivery.js");
    const delivery = new Delivery({
      config,
      manifest,
      store,
      client,
      identity: joined,
      logger,
    });
    await delivery.startup();
    expect(chunks.join("")).not.toContain("SENTINEL_VALUE_DO_NOT_LOG");
  });
});
