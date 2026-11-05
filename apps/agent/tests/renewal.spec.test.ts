import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultClientError } from "../src/client.js";
import { silentAgentLogger } from "../src/logger.js";
import { renewalAt, renewalDue, renewOnce } from "../src/renewal.js";
import { setupAgent } from "./helpers/agent.js";
import { startFakeVault } from "./helpers/fake-vault.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("agent renewal", () => {
  it("should schedule the first attempt at two thirds of the actual lifetime", async () => {
    const fake = await startFakeVault({ ttlDays: 30 });
    cleanups.push(() => fake.close());
    const fixture = await setupAgent(fake);
    cleanups.push(fixture.cleanup);
    const at = renewalAt(fixture.identity);
    const notBefore = new Date(fixture.identity.certificatePem ? Date.now() - 60_000 : 0).getTime();
    expect(at).toBeGreaterThan(notBefore);
    expect(renewalDue(fixture.identity, at)).toBe(true);
    expect(renewalDue(fixture.identity, at - 1)).toBe(false);
  });

  it("should renew with a fresh key and remove the pending file", async () => {
    const fake = await startFakeVault();
    cleanups.push(() => fake.close());
    const fixture = await setupAgent(fake);
    cleanups.push(fixture.cleanup);
    fake.issuedPublicKeys.length = 0;
    const outcome = await renewOnce({
      config: fixture.config,
      manifest: fixture.manifest,
      store: fixture.store,
      client: fixture.client,
      identity: fixture.identity,
      logger: silentAgentLogger,
    });
    expect(outcome.kind).toBe("renewed");
    expect(fake.issuedPublicKeys).toHaveLength(1);
    expect(existsSync(join(fixture.config.stateDir, "pending-renewal.json"))).toBe(false);
    const stored = fixture.store.loadIdentity();
    expect(stored?.serial).not.toBe(fixture.identity.serial);
  });

  it("should reuse the same pending key and CSR after a transient failure", async () => {
    const fake = await startFakeVault();
    cleanups.push(() => fake.close());
    const fixture = await setupAgent(fake);
    cleanups.push(fixture.cleanup);
    let calls = 0;
    const original = fixture.client.renew.bind(fixture.client);
    fixture.client.renew = async (identity, body) => {
      calls += 1;
      if (calls === 1) {
        throw new VaultClientError("transient", "down");
      }
      return original(identity, body);
    };
    const first = await renewOnce({
      config: fixture.config,
      manifest: fixture.manifest,
      store: fixture.store,
      client: fixture.client,
      identity: fixture.identity,
      logger: silentAgentLogger,
    });
    expect(first.kind).toBe("transient");
    const pending = fixture.store.loadPendingRenewal();
    expect(pending?.csrPem).toContain("CERTIFICATE REQUEST");
    const second = await renewOnce({
      config: fixture.config,
      manifest: fixture.manifest,
      store: fixture.store,
      client: fixture.client,
      identity: fixture.identity,
      logger: silentAgentLogger,
    });
    expect(second.kind).toBe("renewed");
    expect(calls).toBe(2);
  });

  it("should fail closed on a renewal 401", async () => {
    const fake = await startFakeVault();
    cleanups.push(() => fake.close());
    const fixture = await setupAgent(fake);
    cleanups.push(fixture.cleanup);
    fixture.client.renew = async () => {
      throw new VaultClientError("credential", "rejected", { status: 401 });
    };
    await expect(
      renewOnce({
        config: fixture.config,
        manifest: fixture.manifest,
        store: fixture.store,
        client: fixture.client,
        identity: fixture.identity,
        logger: silentAgentLogger,
      }),
    ).rejects.toMatchObject({ code: "agent_credential_rejected", removeFiles: true });
  });

  it("should report not_due and stale without removing files", async () => {
    const fake = await startFakeVault();
    cleanups.push(() => fake.close());
    const fixture = await setupAgent(fake);
    cleanups.push(fixture.cleanup);
    fixture.client.renew = async () => {
      throw new VaultClientError("renewal_not_due", "early", { status: 409 });
    };
    await expect(
      renewOnce({
        config: fixture.config,
        manifest: fixture.manifest,
        store: fixture.store,
        client: fixture.client,
        identity: fixture.identity,
        logger: silentAgentLogger,
      }),
    ).resolves.toEqual({ kind: "not_due" });
    fixture.client.renew = async () => {
      throw new VaultClientError("renewal_not_current", "stale", { status: 409 });
    };
    await expect(
      renewOnce({
        config: fixture.config,
        manifest: fixture.manifest,
        store: fixture.store,
        client: fixture.client,
        identity: fixture.identity,
        logger: silentAgentLogger,
      }),
    ).resolves.toEqual({ kind: "stale" });
  });
});
