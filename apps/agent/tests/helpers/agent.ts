import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultClient } from "../../src/client.js";
import { type AgentConfig, loadAgentConfig } from "../../src/config.js";
import { Delivery } from "../../src/delivery.js";
import { joinAgent } from "../../src/join.js";
import { silentAgentLogger } from "../../src/logger.js";
import { type AgentManifest, loadAgentManifest } from "../../src/manifest.js";
import { AgentStateStore, type StoredIdentity } from "../../src/state.js";
import type { FakeVault } from "./fake-vault.js";

/** A joined agent fixture. */
export interface AgentFixture {
  readonly config: AgentConfig;
  readonly manifest: AgentManifest;
  readonly store: AgentStateStore;
  readonly client: VaultClient;
  readonly identity: StoredIdentity;
  readonly delivery: Delivery;
  readonly directory: string;
  cleanup(): void;
}

/** Creates a manifest with the given entry names and optional flags. */
export function manifestText(
  entries: ReadonlyArray<{ name: string; optional?: boolean; env?: string }> = [
    { name: "db-password" },
  ],
  outputDir = "/run/secrets",
): string {
  const lines = [
    "project: payments",
    "service: api",
    "refresh: 300s",
    `output_dir: ${outputDir}`,
    "entries:",
  ];
  for (const entry of entries) {
    lines.push(`  - name: ${entry.name}`);
    if (entry.env === undefined) {
      lines.push(`    file: ${entry.name}`);
    } else {
      lines.push(`    env: ${entry.env}`);
    }
    if (entry.optional === true) {
      lines.push("    optional: true");
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Builds a joined agent fixture against a fake vault. */
export async function setupAgent(
  fake: FakeVault,
  options: {
    readonly entries?: ReadonlyArray<{ name: string; optional?: boolean; env?: string }>;
    readonly overrides?: NodeJS.ProcessEnv;
    readonly mode?: "sidecar" | "wrapper";
  } = {},
): Promise<AgentFixture> {
  const directory = mkdtempSync(join(tmpdir(), "openvault-agent-fixture-"));
  const outputDir = options.overrides?.OPENVAULT_OUTPUT_DIR ?? join(directory, "out");
  const manifestFile = join(directory, "manifest.yaml");
  writeFileSync(manifestFile, manifestText(options.entries, outputDir));
  const env: NodeJS.ProcessEnv = {
    OPENVAULT_URL: fake.url.href,
    OPENVAULT_CA_FILE: fake.caPath,
    OPENVAULT_JOIN_TOKEN: "A".repeat(43),
    OPENVAULT_PROJECT: "payments",
    OPENVAULT_SERVICE: "api",
    COMPOSE_PROJECT_NAME: "payments",
    OPENVAULT_MANIFEST: manifestFile,
    OPENVAULT_OUTPUT_DIR: outputDir,
    OPENVAULT_STATE_DIR: join(directory, "state"),
    OPENVAULT_STATUS_FILE: join(directory, "status.json"),
    OPENVAULT_SOCKET_PATH: join(directory, "agent.sock"),
    ...options.overrides,
  };
  const config = loadAgentConfig(env);
  const manifest = loadAgentManifest(config.manifestPath, {
    project: config.project,
    service: config.service,
    outputDir: config.outputDir,
    mode: options.mode ?? "sidecar",
  });
  const store = new AgentStateStore(config.stateDir);
  const client = new VaultClient({
    baseUrl: config.url,
    caPem: readFileSync(config.caFile, "utf8"),
  });
  const identity = await joinAgent({ config, manifest, store, client, logger: silentAgentLogger });
  const delivery = new Delivery({
    config,
    manifest,
    store,
    client,
    identity,
    logger: silentAgentLogger,
  });
  return {
    config,
    manifest,
    store,
    client,
    identity,
    delivery,
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
