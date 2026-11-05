import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { isNewerCertificate, renewalAt, renewalDue } from "../src/renewal.js";
import { setupAgent } from "./helpers/agent.js";
import { startFakeVault } from "./helpers/fake-vault.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("renewal internals", () => {
  it("should keep a 90-day renewal inside the certificate window", async () => {
    const fake = await startFakeVault({ ttlDays: 90 });
    cleanups.push(() => fake.close());
    const fixture = await setupAgent(fake);
    cleanups.push(fixture.cleanup);
    const certificate = new X509Certificate(fixture.identity.certificatePem);
    const notBefore = new Date(certificate.validFrom).getTime();
    const notAfter = new Date(certificate.validTo).getTime();
    const at = renewalAt(fixture.identity);
    expect(at).toBeGreaterThan(notBefore);
    expect(at).toBeLessThan(notAfter);
    expect(at - notBefore).toBeGreaterThan((notAfter - notBefore) * 0.66);
    expect(renewalDue(fixture.identity, at - 1)).toBe(false);
    expect(renewalDue(fixture.identity, at)).toBe(true);
  });

  it("should compare certificate age for renewal adoption", async () => {
    const fake = await startFakeVault({ ttlDays: 90 });
    cleanups.push(() => fake.close());
    const first = await setupAgent(fake);
    cleanups.push(first.cleanup);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await setupAgent(fake);
    cleanups.push(second.cleanup);
    expect(isNewerCertificate(second.identity, first.identity)).toBe(true);
    expect(isNewerCertificate(first.identity, second.identity)).toBe(false);
  });
});
