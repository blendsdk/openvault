import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultClient } from "../src/client.js";
import { loadAgentConfig } from "../src/config.js";
import { joinAgent } from "../src/join.js";
import { silentAgentLogger } from "../src/logger.js";
import { loadAgentManifest } from "../src/manifest.js";
import { AgentStateStore } from "../src/state.js";
import { type FakeVault, startFakeVault } from "./helpers/fake-vault.js";

const cleanups: Array<() => Promise<void> | void> = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openvault-agent-join-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function manifestPath(directory: string, outputDir: string): string {
  const path = join(directory, "manifest.yaml");
  writeFileSync(
    path,
    `project: payments
service: api
output_dir: ${outputDir}
entries:
  - name: db-password
    file: db_password
`,
  );
  return path;
}

async function setup(
  fake: FakeVault,
  overrides: NodeJS.ProcessEnv = {},
): Promise<{
  config: ReturnType<typeof loadAgentConfig>;
  manifest: ReturnType<typeof loadAgentManifest>;
  store: AgentStateStore;
  client: VaultClient;
  directory: string;
}> {
  const directory = tempDirectory();
  const env: NodeJS.ProcessEnv = {
    OPENVAULT_URL: fake.url.href,
    OPENVAULT_CA_FILE: fake.caPath,
    OPENVAULT_JOIN_TOKEN: "A".repeat(43),
    OPENVAULT_PROJECT: "payments",
    OPENVAULT_SERVICE: "api",
    COMPOSE_PROJECT_NAME: "payments",
    OPENVAULT_MANIFEST: manifestPath(directory, join(directory, "out")),
    OPENVAULT_OUTPUT_DIR: join(directory, "out"),
    OPENVAULT_STATE_DIR: join(directory, "state"),
    OPENVAULT_STATUS_FILE: join(directory, "status.json"),
    OPENVAULT_SOCKET_PATH: join(directory, "agent.sock"),
    ...overrides,
  };
  const config = loadAgentConfig(env);
  const manifest = loadAgentManifest(config.manifestPath, {
    project: config.project,
    service: config.service,
    outputDir: config.outputDir,
    mode: "sidecar",
  });
  return {
    config,
    manifest,
    store: new AgentStateStore(config.stateDir),
    client: new VaultClient({ baseUrl: config.url, caPem: readFileSync(config.caFile, "utf8") }),
    directory,
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("agent join", () => {
  it("should generate a P-256 CSR, store 0600 state, and never upload a private key", async () => {
    const fake = await startFakeVault();
    cleanups.push(() => fake.close());
    const { config, manifest, store, client } = await setup(fake);

    const identity = await joinAgent({
      config,
      manifest,
      store,
      client,
      logger: silentAgentLogger,
    });

    expect(identity.certificatePem).toContain("BEGIN CERTIFICATE");
    expect(identity.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(fake.requests).toHaveLength(1);
    const body = fake.requests[0]?.body as Record<string, unknown>;
    expect(body.csr).toContain("BEGIN CERTIFICATE REQUEST");
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
    expect(statSync(config.stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(config.stateDir, "identity.json")).mode & 0o777).toBe(0o600);
  });

  it("should reuse a valid identity without a join request", async () => {
    const fake = await startFakeVault();
    cleanups.push(() => fake.close());
    const { config, manifest, store, client } = await setup(fake);
    const first = await joinAgent({ config, manifest, store, client, logger: silentAgentLogger });
    const second = await joinAgent({ config, manifest, store, client, logger: silentAgentLogger });
    expect(second.identityId).toBe(first.identityId);
    expect(fake.requests).toHaveLength(1);
  });

  it("should require a token when no valid identity exists", async () => {
    const fake = await startFakeVault();
    cleanups.push(() => fake.close());
    const { config, manifest, store, client } = await setup(fake);
    await expect(
      joinAgent({
        config: { ...config, joinToken: undefined },
        manifest,
        store,
        client,
        logger: silentAgentLogger,
      }),
    ).rejects.toMatchObject({ code: "agent_join_token_required" });
  });

  it("should fail closed on a world-readable state file", async () => {
    const fake = await startFakeVault();
    cleanups.push(() => fake.close());
    const { config, manifest, store, client } = await setup(fake);
    await joinAgent({ config, manifest, store, client, logger: silentAgentLogger });
    const path = join(config.stateDir, "identity.json");
    chmodSync(path, 0o644);
    expect(() => store.loadIdentity()).toThrow(/0600/);
  });

  it("should retry the same request on a transient failure", async () => {
    const fake = await startFakeVault();
    cleanups.push(() => fake.close());
    const { config, manifest, store, client } = await setup(fake);
    let calls = 0;
    const original = client.join.bind(client);
    client.join = async (body: unknown) => {
      calls += 1;
      if (calls === 1) {
        throw new (await import("../src/client.js")).VaultClientError("transient", "down");
      }
      return original(body);
    };
    const identity = await joinAgent({
      config,
      manifest,
      store,
      client,
      logger: silentAgentLogger,
      sleep: async () => undefined,
    });
    expect(identity.identityId).toBeDefined();
    expect(calls).toBe(2);
    expect(fake.issuedPublicKeys).toHaveLength(1);
  });

  it("should fail terminal on a rejected token", async () => {
    const fake = await startFakeVault();
    cleanups.push(() => fake.close());
    const { config, manifest, store, client } = await setup(fake, {
      OPENVAULT_JOIN_TOKEN: "B".repeat(43),
    });
    await expect(
      joinAgent({ config, manifest, store, client, logger: silentAgentLogger }),
    ).rejects.toMatchObject({ code: "agent_join_failed" });
  });
});
