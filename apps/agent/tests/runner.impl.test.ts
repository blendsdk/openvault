import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { silentAgentLogger } from "../src/logger.js";
import { AgentRunner } from "../src/runner.js";
import { setupAgent } from "./helpers/agent.js";
import { startFakeVault } from "./helpers/fake-vault.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("runner internals", () => {
  it("should keep delivered files when the status file cannot be written", async () => {
    const fake = await startFakeVault();
    cleanups.push(() => fake.close());
    fake.values.set("db-password", { value: "value", encoding: "utf8" });
    const fixture = await setupAgent(fake);
    cleanups.push(fixture.cleanup);
    mkdirSync(fixture.config.statusFile);
    const runner = new AgentRunner({
      config: fixture.config,
      manifest: fixture.manifest,
      store: fixture.store,
      logger: silentAgentLogger,
    });
    expect(await runner.runOnce()).toBe(2);
    expect(existsSync(join(fixture.config.outputDir, "db-password"))).toBe(true);
  });
});
