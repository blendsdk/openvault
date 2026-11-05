import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeSan, parseCertificateMaterial } from "../../src/certificates/pem.js";
import {
  createChainFixture,
  createEd25519Fixture,
  createExpiredFixture,
  createInvalidChainFixture,
  createMismatchedFixture,
  createNotYetValidFixture,
  createPkcs1BodyFixture,
  createSelfSignedFixture,
} from "./helpers/certificate-fixtures.js";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const MAX = 131_072;

function parse(input: {
  certificatePem: string;
  chainPem?: string;
  privateKeyPem: string;
  allowNotYetValid?: boolean;
}) {
  return parseCertificateMaterial({
    certificatePem: input.certificatePem,
    ...(input.chainPem === undefined ? {} : { chainPem: input.chainPem }),
    privateKeyPem: input.privateKeyPem,
    allowNotYetValid: input.allowNotYetValid ?? false,
    now: NOW,
    maximumBytes: MAX,
  });
}

describe("certificate PEM parsing", () => {
  it("should parse a valid EC certificate and matching key", async () => {
    const fixture = await createSelfSignedFixture({ now: NOW });
    const parsed = await parse(fixture);
    expect(parsed.privateKeyType).toBe("ec-p256");
    expect(parsed.subject).toBe("CN=fixture.example.test");
    expect(parsed.sans).toEqual(["DNS:fixture.example.test"]);
    expect(parsed.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.chainLength).toBe(1);
  });

  it("should parse a valid RSA 2048 certificate and matching key", async () => {
    const fixture = await createSelfSignedFixture({ keyType: "rsa-2048", now: NOW });
    const parsed = await parse(fixture);
    expect(parsed.privateKeyType).toBe("rsa-2048");
  });

  it("should parse a valid leaf with an intermediate and root", async () => {
    const fixture = await createChainFixture({ now: NOW });
    const parsed = await parse({
      certificatePem: fixture.leafPem,
      chainPem: fixture.chainPem,
      privateKeyPem: fixture.privateKeyPem,
    });
    expect(parsed.chainLength).toBe(3);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.certificateChainPem.split("-----END CERTIFICATE-----").length).toBe(4);
  });

  it("should reject a chain that claims the issuer with the wrong key", async () => {
    const fixture = await createInvalidChainFixture();
    await expect(
      parse({
        certificatePem: fixture.certificatePem,
        chainPem: fixture.chainPem,
        privateKeyPem: fixture.privateKeyPem,
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: "validation_error" });
  });

  it("should warn about an expired intermediate", async () => {
    const fixture = await createChainFixture({
      now: NOW,
      intermediateNotBefore: new Date(NOW - 30 * 86_400_000),
      intermediateNotAfter: new Date(NOW - 86_400_000),
    });
    const parsed = await parse({
      certificatePem: fixture.leafPem,
      chainPem: fixture.chainPem,
      privateKeyPem: fixture.privateKeyPem,
    });
    expect(parsed.warnings.map((warning) => warning.code)).toContain("expired_intermediate");
  });

  it("should warn about a not-yet-valid intermediate", async () => {
    const fixture = await createChainFixture({
      now: NOW,
      intermediateNotBefore: new Date(NOW + 86_400_000),
      intermediateNotAfter: new Date(NOW + 365 * 86_400_000),
    });
    const parsed = await parse({
      certificatePem: fixture.leafPem,
      chainPem: fixture.chainPem,
      privateKeyPem: fixture.privateKeyPem,
    });
    expect(parsed.warnings.map((warning) => warning.code)).toContain("not_yet_valid_intermediate");
  });

  it("should reject a non-CA or non-keyCertSign intermediate", async () => {
    const fixture = await createChainFixture({
      now: NOW,
      intermediateCa: false,
    });
    await expect(
      parse({
        certificatePem: fixture.leafPem,
        chainPem: fixture.chainPem,
        privateKeyPem: fixture.privateKeyPem,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("should import a leaf with a missing intermediate and drop the unrelated root", async () => {
    const fixture = await createChainFixture({ now: NOW });
    const parsed = await parse({
      certificatePem: fixture.leafPem,
      chainPem: fixture.rootPem,
      privateKeyPem: fixture.privateKeyPem,
    });
    expect(parsed.chainLength).toBe(1);
    expect(parsed.warnings.map((warning) => warning.code)).toContain("missing_intermediate");
  });

  it("should reject a not-yet-valid leaf unless allowed", async () => {
    const fixture = await createNotYetValidFixture(NOW);
    await expect(parse(fixture)).rejects.toMatchObject({ statusCode: 422 });
    const parsed = await parse({ ...fixture, allowNotYetValid: true });
    expect(parsed.warnings.map((warning) => warning.code)).toContain("not_yet_valid");
  });

  it("should import an expired leaf with a warning", async () => {
    const fixture = await createExpiredFixture(NOW);
    const parsed = await parse(fixture);
    expect(parsed.warnings.map((warning) => warning.code)).toContain("expired");
  });

  it("should reject a mismatched key", async () => {
    const fixture = await createMismatchedFixture();
    await expect(parse(fixture)).rejects.toMatchObject({ statusCode: 422 });
  });

  it("should reject a PKCS#1 body under a PRIVATE KEY label", async () => {
    const fixture = await createPkcs1BodyFixture();
    await expect(parse(fixture)).rejects.toMatchObject({ statusCode: 422 });
  });

  it("should reject an encrypted private key", async () => {
    const fixture = await createSelfSignedFixture({ now: NOW });
    const key = createPrivateKey({ key: fixture.privateKeyPem, format: "pem" });
    const encrypted = key.export({
      format: "pem",
      type: "pkcs8",
      cipher: "aes-256-cbc",
      passphrase: "test",
    });
    if (typeof encrypted !== "string") {
      throw new Error("encrypted export failed");
    }
    await expect(
      parse({ certificatePem: fixture.certificatePem, privateKeyPem: encrypted }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("should reject an Ed25519 key", async () => {
    const fixture = await createEd25519Fixture();
    await expect(parse(fixture)).rejects.toMatchObject({ statusCode: 422 });
  });

  it("should reject multiple leaf blocks and text outside blocks", async () => {
    const fixture = await createSelfSignedFixture({ now: NOW });
    await expect(
      parse({
        certificatePem: `${fixture.certificatePem}\n${fixture.certificatePem}`,
        privateKeyPem: fixture.privateKeyPem,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      parse({
        certificatePem: `junk\n${fixture.certificatePem}`,
        privateKeyPem: fixture.privateKeyPem,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("should reject oversized public and private material", async () => {
    const fixture = await createSelfSignedFixture({ now: NOW });
    await expect(
      parse({
        certificatePem: "a".repeat(MAX + 1),
        privateKeyPem: fixture.privateKeyPem,
      }),
    ).rejects.toMatchObject({ statusCode: 413 });
    await expect(
      parse({
        certificatePem: fixture.certificatePem,
        privateKeyPem: "a".repeat(16_385),
      }),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  it("should reject RSA 4096, RSA-PSS, and EC P-384 keys", async () => {
    const fixture = await createSelfSignedFixture({ now: NOW });
    const cases = [
      generateKeyPairSync("rsa", { modulusLength: 4096 }).privateKey,
      generateKeyPairSync("rsa-pss", { modulusLength: 2048 }).privateKey,
      generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey,
    ];
    for (const key of cases) {
      const pem = key.export({ format: "pem", type: "pkcs8" });
      if (typeof pem !== "string") {
        throw new Error("key export failed");
      }
      await expect(
        parse({ certificatePem: fixture.certificatePem, privateKeyPem: pem }),
      ).rejects.toMatchObject({ statusCode: 422 });
    }
  });

  it("should validate SAN grammar", () => {
    expect(canonicalizeSan("DNS:Example.COM")).toBe("DNS:example.com");
    expect(canonicalizeSan("email:OPS@EXAMPLE.TEST")).toBe("email:ops@example.test");
    expect(() => canonicalizeSan(`email:${"a".repeat(310)}@example.test`)).toThrow();
    expect(() => canonicalizeSan("email:ops@-example.test")).toThrow();
    expect(canonicalizeSan("DNS:*.example.com")).toBe("DNS:*.example.com");
    expect(canonicalizeSan("IP:127.0.0.1")).toBe("IP:127.0.0.1");
    expect(canonicalizeSan("IP:::1")).toBe("IP:::1");
    expect(canonicalizeSan("URI:openvault://identity/x")).toBe("URI:openvault://identity/x");
    expect(canonicalizeSan("email:ops@example.test")).toBe("email:ops@example.test");
    for (const value of [
      "DNS:foo.*.com",
      "IP:999.1.1.1",
      "URI:relative/path",
      "email:not-an-email",
      "OTHER:value",
    ]) {
      expect(() => canonicalizeSan(value)).toThrow();
    }
  });
});
