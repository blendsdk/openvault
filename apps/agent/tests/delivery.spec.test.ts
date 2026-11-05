import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryTerminalError } from "../src/delivery.js";
import { setupAgent } from "./helpers/agent.js";
import { type FakeVault, startFakeVault } from "./helpers/fake-vault.js";

const cleanups: Array<() => Promise<void> | void> = [];

async function fakeWithValues(
  entries: Array<{ name: string; optional?: boolean; env?: string }> = [{ name: "db-password" }],
): Promise<{ fake: FakeVault; fixture: Awaited<ReturnType<typeof setupAgent>> }> {
  const fake = await startFakeVault();
  cleanups.push(() => fake.close());
  for (const entry of entries) {
    fake.values.set(entry.name, { value: `value-${entry.name}`, encoding: "utf8" });
  }
  const fixture = await setupAgent(fake, { entries });
  cleanups.push(fixture.cleanup);
  return { fake, fixture };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("agent delivery", () => {
  it("should write required files with mode 0400 on startup", async () => {
    const { fixture } = await fakeWithValues();
    const snapshot = await fixture.delivery.startup();
    expect(snapshot.state).toBe("ok");
    expect(snapshot.requiredReady).toBe(true);
    const path = join(fixture.config.outputDir, "db-password");
    expect(readFileSync(path, "utf8")).toBe("value-db-password");
    expect(statSync(path).mode & 0o777).toBe(0o400);
  });

  it("should write nothing when a required secret is missing at startup", async () => {
    const { fake, fixture } = await fakeWithValues();
    fake.values.delete("db-password");
    await expect(fixture.delivery.startup()).rejects.toMatchObject({
      code: "agent_secret_not_found",
      removeFiles: true,
    });
    expect(existsSync(join(fixture.config.outputDir, "db-password"))).toBe(false);
  });

  it("should write nothing when a required secret returns 500 at startup", async () => {
    const { fake, fixture } = await fakeWithValues();
    fake.faults.set("GET /v1/data/payments/secrets/db-password", { status: 500 });
    await expect(fixture.delivery.startup()).rejects.toMatchObject({
      code: "agent_transient",
      removeFiles: false,
    });
    expect(existsSync(join(fixture.config.outputDir, "db-password"))).toBe(false);
  });

  it("should keep last-known-good and degrade on a refresh 500", async () => {
    const { fake, fixture } = await fakeWithValues();
    await fixture.delivery.startup();
    fake.faults.set("GET /v1/data/payments/secrets/db-password", { status: 500 });
    const snapshot = await fixture.delivery.refresh();
    expect(snapshot.state).toBe("degraded");
    expect(readFileSync(join(fixture.config.outputDir, "db-password"), "utf8")).toBe(
      "value-db-password",
    );
  });

  it("should recover from degraded to ok after a clean refresh", async () => {
    const { fake, fixture } = await fakeWithValues();
    await fixture.delivery.startup();
    fake.faults.set("GET /v1/data/payments/secrets/db-password", { status: 500 });
    expect((await fixture.delivery.refresh()).state).toBe("degraded");
    fake.faults.delete("GET /v1/data/payments/secrets/db-password");
    expect((await fixture.delivery.refresh()).state).toBe("ok");
  });

  it("should remove every managed file and fail on a refresh 401", async () => {
    const { fake, fixture } = await fakeWithValues();
    await fixture.delivery.startup();
    fake.faults.set("GET /v1/data/payments/secrets/db-password", {
      status: 401,
      code: "authentication_required",
    });
    let error: unknown;
    try {
      await fixture.delivery.refresh();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DeliveryTerminalError);
    expect(error).toMatchObject({ code: "agent_credential_rejected", removeFiles: true });
    fixture.delivery.removeManagedFiles();
    expect(existsSync(join(fixture.config.outputDir, "db-password"))).toBe(false);
  });

  it("should remove all files on a required refresh 404", async () => {
    const { fake, fixture } = await fakeWithValues();
    await fixture.delivery.startup();
    fake.values.delete("db-password");
    await expect(fixture.delivery.refresh()).rejects.toMatchObject({
      code: "agent_secret_not_found",
      removeFiles: true,
    });
  });

  it("should remove only the optional file on an optional 404", async () => {
    const entries = [{ name: "db-password" }, { name: "legacy", optional: true }];
    const { fake, fixture } = await fakeWithValues(entries);
    await fixture.delivery.startup();
    fake.values.delete("legacy");
    const snapshot = await fixture.delivery.refresh();
    expect(snapshot.state).toBe("degraded");
    expect(existsSync(join(fixture.config.outputDir, "db-password"))).toBe(true);
    expect(existsSync(join(fixture.config.outputDir, "legacy"))).toBe(false);
  });

  it("should deliver both file and env targets in wrapper mode", async () => {
    const entries = [{ name: "db-password", env: "DB_PASSWORD" }];
    const fake = await startFakeVault();
    cleanups.push(() => fake.close());
    fake.values.set("db-password", { value: "value-db-password", encoding: "utf8" });
    const fixture = await setupAgent(fake, { entries, mode: "wrapper" });
    cleanups.push(fixture.cleanup);
    const snapshot = await fixture.delivery.startup();
    expect(snapshot.state).toBe("ok");
    expect(fixture.delivery.getDelivered("db-password")?.entry.env[0]?.name).toBe("DB_PASSWORD");
  });

  it("should clean up a file that is no longer in the manifest", async () => {
    const { fake, fixture } = await fakeWithValues();
    await fixture.delivery.startup();
    const old = join(fixture.config.outputDir, "db-password");
    expect(existsSync(old)).toBe(true);
    const nextManifest = {
      ...fixture.manifest,
      entries: [
        {
          name: "other",
          files: [{ name: "other", mode: 0o400 as const }],
          env: [],
          optional: false,
        },
      ],
    };
    fake.values.set("other", { value: "other-value", encoding: "utf8" });
    const { Delivery } = await import("../src/delivery.js");
    const next = new Delivery({
      config: fixture.config,
      manifest: nextManifest,
      store: fixture.store,
      client: fixture.client,
      identity: fixture.identity,
      logger: (await import("../src/logger.js")).silentAgentLogger,
    });
    await next.startup();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(fixture.config.outputDir, "other"))).toBe(true);
  });
});
