import "reflect-metadata";
import { createPrivateKey, createPublicKey } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { generateSelfSignedCertificate } from "../../src/certificates/generate.js";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");

describe("self-signed certificate generation", () => {
  it("should generate RSA 2048, RSA 3072, and EC P-256 certificates", async () => {
    for (const keyType of ["rsa-2048", "rsa-3072", "ec-p256"] as const) {
      const generated = await generateSelfSignedCertificate({
        subject: "CN=generated.example.test",
        sans: ["DNS:generated.example.test", "IP:127.0.0.1"],
        keyType,
        validityDays: 30,
        maximumBytes: 131_072,
        now: NOW,
      });
      const certificate = new x509.X509Certificate(generated.certificatePem);
      expect(await certificate.verify({ publicKey: certificate.publicKey })).toBe(true);
      expect(certificate.subject).toBe("CN=generated.example.test");
      expect(certificate.notBefore.getTime()).toBeLessThanOrEqual(NOW);
      expect(certificate.notAfter.getTime()).toBeGreaterThan(NOW);
      expect(generated.keyType).toBe(keyType);
      const names = certificate.getExtension(x509.SubjectAlternativeNameExtension)?.names.items;
      expect(names?.map((name) => name.value)).toEqual(["generated.example.test", "127.0.0.1"]);
      const privateKey = createPrivateKey({ key: generated.privateKeyPem, format: "pem" });
      const privateSpki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
      expect(Buffer.from(certificate.publicKey.rawData).equals(privateSpki)).toBe(true);
      const basic = certificate.getExtension(x509.BasicConstraintsExtension);
      expect(basic?.ca).toBe(false);
      const usage = certificate.getExtension(x509.KeyUsagesExtension);
      expect(usage?.usages ?? 0).toBeGreaterThan(0);
    }
  }, 60_000);

  it("should reject an invalid subject", async () => {
    await expect(
      generateSelfSignedCertificate({
        subject: "not a dn",
        sans: ["DNS:generated.example.test"],
        keyType: "ec-p256",
        validityDays: 30,
        maximumBytes: 131_072,
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("should reject an invalid SAN", async () => {
    await expect(
      generateSelfSignedCertificate({
        subject: "CN=generated.example.test",
        sans: ["IP:999.1.1.1"],
        keyType: "ec-p256",
        validityDays: 30,
        maximumBytes: 131_072,
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});
