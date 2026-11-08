import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VaultClient } from "../src/client.js";
import { Delivery, DeliveryCancelledError } from "../src/delivery.js";
import { silentAgentLogger } from "../src/logger.js";
import { setupAgent } from "./helpers/agent.js";
import { startFakeVault } from "./helpers/fake-vault.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("delivery cancellation and cleanup", () => {
  it("should not re-add a file after a terminal removal", async () => {
    const fake = await startFakeVault();
    cleanups.push(() => fake.close());
    fake.values.set("db-password", { value: "first", encoding: "utf8" });
    const fixture = await setupAgent(fake);
    cleanups.push(fixture.cleanup);
    await fixture.delivery.startup();
    const target = join(fixture.config.outputDir, "db-password");
    expect(existsSync(target)).toBe(true);

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cancelled = false;
    const delayedClient = {
      readSecret: async () => {
        await gate;
        return {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          name: "db-password",
          value: "second",
          encoding: "utf8" as const,
          contentType: "text/plain",
          tags: {},
          version: {
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            createdAt: new Date().toISOString(),
            createdBy: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            expiresAt: null,
          },
          capabilities: {
            canRead: true,
            canWrite: false,
            canDelete: false,
            canRecover: false,
            canPurge: false,
            canManage: false,
            canReadPrivate: false,
          },
        };
      },
    } as unknown as VaultClient;
    const delivery = new Delivery({
      config: fixture.config,
      manifest: fixture.manifest,
      store: fixture.store,
      client: delayedClient,
      identity: fixture.identity,
      logger: silentAgentLogger,
      isCancelled: () => cancelled,
    });
    const refresh = delivery.refresh();
    cancelled = true;
    delivery.removeManagedFiles();
    release?.();
    await expect(refresh).rejects.toBeInstanceOf(DeliveryCancelledError);
    expect(existsSync(target)).toBe(false);
  });

  it("should continue cleanup when one target cannot be removed", async () => {
    const fake = await startFakeVault();
    cleanups.push(() => fake.close());
    fake.values.set("alpha", { value: "a", encoding: "utf8" });
    fake.values.set("beta", { value: "b", encoding: "utf8" });
    const fixture = await setupAgent(fake, {
      entries: [{ name: "alpha" }, { name: "beta" }],
    });
    cleanups.push(fixture.cleanup);
    await fixture.delivery.startup();
    const alpha = join(fixture.config.outputDir, "alpha");
    const beta = join(fixture.config.outputDir, "beta");
    rmSync(alpha);
    mkdirSync(alpha);
    expect(() => fixture.delivery.removeManagedFiles()).toThrow();
    expect(existsSync(beta)).toBe(false);
    rmSync(alpha, { recursive: true, force: true });
  });
});
