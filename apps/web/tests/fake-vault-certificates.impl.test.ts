import { describe, expect, it } from "vitest";
import { createOpenVaultWebClient } from "../src/generated/index.js";
import { CsrfCookieAuth } from "../src/session/csrf-cookie-auth.js";
import {
  FakeVault,
  TEST_CERTIFICATE_PEM,
  TEST_CSRF,
  TEST_PRIVATE_KEY_PEM,
} from "./helpers/fake-vault.js";

function clientFor(vault: FakeVault) {
  return createOpenVaultWebClient({
    baseUrl: "",
    adapter: vault,
    auth: new CsrfCookieAuth({ currentToken: () => TEST_CSRF, refresh: async () => true }),
  });
}

describe("FakeVault certificate routes", () => {
  it("should serve active and deleted certificate lists", async () => {
    const vault = new FakeVault();
    const client = clientFor(vault);

    const active = await client.certificates.listCertificates({
      project: "payments",
      status: "active",
      limit: 25,
    });
    expect(active.certificates.map((entry) => entry.name)).toContain("api-tls");
    expect(active.certificates.map((entry) => entry.name)).not.toContain("retired-tls");

    const deleted = await client.certificates.listCertificates({
      project: "payments",
      status: "deleted",
      limit: 25,
    });
    expect(deleted.certificates.map((entry) => entry.name)).toContain("retired-tls");
    expect(deleted.certificates.every((entry) => entry.status === "deleted")).toBe(true);
  });

  it("should serve public and private certificate reads", async () => {
    const vault = new FakeVault();
    const client = clientFor(vault);
    const version = vault.certificates[0]?.version.id;

    const publicRead = await client.certificates.getCertificate({
      project: "payments",
      name: "api-tls",
      version,
    });
    expect(publicRead.certificatePem).toBe(TEST_CERTIFICATE_PEM);

    const privateRead = await client.certificates.getCertificatePrivateKey({
      project: "payments",
      name: "api-tls",
      version,
    });
    expect(privateRead.privateKeyPem).toBe(TEST_PRIVATE_KEY_PEM);
    expect(vault.privateKeyRevealCount).toBe(1);
  });

  it("should accept import and generate writes", async () => {
    const vault = new FakeVault();
    const client = clientFor(vault);

    const imported = await client.certificates.importCertificate({
      project: "payments",
      name: "imported-tls",
      certificatePem: TEST_CERTIFICATE_PEM,
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
      tags: { env: "test" },
      allowNotYetValid: false,
    });
    expect(imported.version.id).toBeTruthy();
    expect(imported.certificatePem).toBe(TEST_CERTIFICATE_PEM);

    const generated = await client.certificates.generateCertificate({
      project: "payments",
      name: "generated-tls",
      subject: "CN=generated.example.test",
      sans: ["DNS:generated.example.test"],
      keyType: "ec-p256",
      validityDays: 30,
      tags: {},
    });
    expect(generated.subject).toBe("CN=generated.example.test");
    expect(generated.version.id).toBeTruthy();
  });

  it("should update metadata, delete, recover, and purge", async () => {
    const vault = new FakeVault();
    const client = clientFor(vault);

    const updated = await client.certificates.updateCertificateMetadata({
      project: "payments",
      name: "api-tls",
      tags: { env: "stage" },
      purgeProtected: true,
    });
    expect(updated.tags).toEqual({ env: "stage" });
    expect(updated.purgeProtected).toBe(true);

    await client.certificates.deleteCertificate({ project: "payments", name: "api-tls" });
    expect(vault.certificates.find((entry) => entry.name === "api-tls")?.status).toBe("deleted");

    const recovered = await client.certificates.recoverCertificate({
      project: "payments",
      name: "api-tls",
    });
    expect(recovered.status).toBe("active");

    const retired = vault.certificates.find((entry) => entry.name === "retired-tls");
    expect(retired).toBeDefined();
    if (retired !== undefined) {
      retired.purgeProtected = false;
      retired.purgeAfter = "2020-01-01T00:00:00.000Z";
    }
    await client.certificates.purgeCertificate({ project: "payments", name: "retired-tls" });
    expect(vault.certificates.some((entry) => entry.name === "retired-tls")).toBe(false);
  });

  it("should surface a configured write conflict", async () => {
    const vault = new FakeVault();
    const client = clientFor(vault);
    vault.failCertificate = {
      status: 409,
      code: "certificate_version_conflict",
      message: "This certificate changed. Reload the page and try again.",
    };

    await expect(
      client.certificates.importCertificate({
        project: "payments",
        name: "api-tls",
        certificatePem: TEST_CERTIFICATE_PEM,
        privateKeyPem: TEST_PRIVATE_KEY_PEM,
        allowNotYetValid: false,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "certificate_version_conflict" });
  });
});
