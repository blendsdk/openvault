import { randomBytes } from "node:crypto";
import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CaSigner,
  CaSignerUnavailableError,
  unwrapCaScalar,
  wrapCaScalar,
} from "../../src/security/ca.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import {
  CsrValidationError,
  canonicalPublicKeyHash,
  parseAgentCsr,
  verifyAgentCertificateProfile,
  x509,
} from "../../src/security/x509.js";
import { createAgentCaFixture, createAgentCsr, seedCaKey, sha256Hex } from "./helpers/agent-tls.js";
import { createServerEnvironment, type ServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

const PRINCIPAL = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FIXED_NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

let testDb: TestDatabase;
let environment: ServerEnvironment;
let keyring: KeyringProvider;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  environment = createServerEnvironment();
  keyring = await KeyringProvider.load(environment.keyringPath);
}, 30_000);

afterAll(async () => {
  environment?.cleanup();
  await testDb?.cleanup();
});

async function currentCa(): Promise<Awaited<ReturnType<typeof createAgentCaFixture>>> {
  const ca = await createAgentCaFixture();
  await testDb.db.executeQuery("DELETE FROM ca_keys");
  await seedCaKey(testDb.db, keyring, ca);
  return ca;
}

describe("CA scalar wrapping", () => {
  it("should round-trip a scalar and reject wrong AAD, KEK, tag, and length", async () => {
    const ca = await createAgentCaFixture();
    try {
      const id = newUlid();
      const wrapped = wrapCaScalar(keyring, id, ca.scalar);
      expect(wrapped.wrappedKey).toHaveLength(32);
      expect(wrapped.wrapNonce).toHaveLength(12);
      expect(wrapped.wrapTag).toHaveLength(16);
      expect(wrapped.wrappedKey.equals(ca.scalar)).toBe(false);

      const scalar = unwrapCaScalar(keyring, {
        id,
        wrappedKey: wrapped.wrappedKey,
        wrapNonce: wrapped.wrapNonce,
        wrapTag: wrapped.wrapTag,
        kekId: wrapped.kekId,
      });
      expect(scalar.equals(ca.scalar)).toBe(true);
      scalar.fill(0);

      const failures = [
        () =>
          unwrapCaScalar(keyring, {
            id: newUlid(),
            wrappedKey: wrapped.wrappedKey,
            wrapNonce: wrapped.wrapNonce,
            wrapTag: wrapped.wrapTag,
            kekId: wrapped.kekId,
          }),
        () =>
          unwrapCaScalar(keyring, {
            id,
            wrappedKey: wrapped.wrappedKey,
            wrapNonce: wrapped.wrapNonce,
            wrapTag: wrapped.wrapTag,
            kekId: "missing-kek",
          }),
        () => {
          const tag = Buffer.from(wrapped.wrapTag);
          tag[0] = (tag[0] ?? 0) ^ 0xff;
          return unwrapCaScalar(keyring, { id, ...wrapped, wrapTag: tag });
        },
        () =>
          unwrapCaScalar(keyring, {
            id,
            ...wrapped,
            wrappedKey: wrapped.wrappedKey.subarray(0, 31),
          }),
      ];

      for (const failure of failures) {
        expect(failure).toThrow();
      }
      for (const failure of failures) {
        try {
          failure();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          expect(message).not.toContain(ca.scalar.toString("hex"));
          expect(message).not.toContain(wrapped.wrappedKey.toString("hex"));
        }
      }
    } finally {
      ca.cleanup();
    }
  });
});

describe("CA signer loading and issuance", () => {
  it("should load a matching row, probe, and issue the fixed profile", async () => {
    const ca = await currentCa();
    try {
      const signer = await CaSigner.load({
        database: testDb.db,
        keyring,
        caPem: ca.certPem,
        now: () => FIXED_NOW,
      });
      await expect(signer.probe()).resolves.toBeUndefined();

      const csr = await createAgentCsr();
      const issued = await signer.issueClientCertificate(csr, PRINCIPAL, 30);
      expect(issued.serial).toMatch(/^[0-9a-f]+$/);
      expect(issued.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(issued.fingerprint).toBe(
        sha256Hex(Buffer.from(new x509.X509Certificate(issued.certificatePem).rawData)),
      );
      expect(issued.notBefore.getTime()).toBe(FIXED_NOW - 30_000);
      expect(issued.notAfter.getTime() - issued.notBefore.getTime()).toBe(30 * 86_400_000);

      await expect(
        verifyAgentCertificateProfile(issued.certificatePem, ca.cert, PRINCIPAL),
      ).resolves.toBeUndefined();
      const certificate = new x509.X509Certificate(issued.certificatePem);
      expect(certificate.subject).toBe(`CN=${PRINCIPAL}`);
      expect(certificate.issuer).toBe(ca.cert.subject);
      expect(canonicalPublicKeyHash(Buffer.from(certificate.publicKey.rawData))).toBe(
        csr.publicKeySha256,
      );
      const basicConstraints = certificate.getExtension(x509.BasicConstraintsExtension);
      expect(basicConstraints?.ca).toBe(false);
      expect(basicConstraints?.critical).toBe(true);
      const keyUsages = certificate.getExtension(x509.KeyUsagesExtension);
      expect(keyUsages?.usages).toBe(x509.KeyUsageFlags.digitalSignature);
      expect(keyUsages?.critical).toBe(true);
      expect(certificate.getExtension(x509.ExtendedKeyUsageExtension)?.usages).toEqual([
        x509.ExtendedKeyUsage.clientAuth,
      ]);
      const names = certificate.getExtension(x509.SubjectAlternativeNameExtension)?.names;
      expect(names?.items.map((name) => name.value)).toEqual([`openvault://identity/${PRINCIPAL}`]);
      expect(issued.certificatePem).not.toContain("PRIVATE KEY");

      signer.destroy();
      await expect(signer.probe()).rejects.toBeInstanceOf(CaSignerUnavailableError);
    } finally {
      ca.cleanup();
    }
  });

  it("should issue the configured 1, 30, and 90 day windows", async () => {
    const ca = await currentCa();
    try {
      const signer = await CaSigner.load({
        database: testDb.db,
        keyring,
        caPem: ca.certPem,
        now: () => FIXED_NOW,
      });
      const csr = await createAgentCsr();
      for (const ttlDays of [1, 30, 90]) {
        const issued = await signer.issueClientCertificate(csr, PRINCIPAL, ttlDays);
        expect(issued.notBefore.getTime()).toBe(FIXED_NOW - 30_000);
        expect(issued.notAfter.getTime() - issued.notBefore.getTime()).toBe(ttlDays * 86_400_000);
      }
      signer.destroy();
    } finally {
      ca.cleanup();
    }
  });

  it("should normalize a deterministic serial and expose no key material", async () => {
    const ca = await currentCa();
    try {
      const signer = await CaSigner.load({
        database: testDb.db,
        keyring,
        caPem: ca.certPem,
        now: () => FIXED_NOW,
        serialSource: () => "00ABCDEF",
      });
      const csr = await createAgentCsr();
      const issued = await signer.issueClientCertificate(csr, PRINCIPAL, 30);
      expect(issued.serial).toBe("abcdef");
      expect(JSON.stringify(signer)).not.toContain(ca.scalar.toString("hex"));
      expect(JSON.stringify(signer)).not.toContain("wrapped_key");
      signer.destroy();
    } finally {
      ca.cleanup();
    }
  });

  it("should never return a private key from a CA bundle", async () => {
    const ca = await currentCa();
    try {
      const bundle = `${ca.certPem}\n${ca.keyPem}`;
      const signer = await CaSigner.load({
        database: testDb.db,
        keyring,
        caPem: bundle,
        now: () => FIXED_NOW,
      });
      expect(signer.certificatePem).toContain("BEGIN CERTIFICATE");
      expect(signer.certificatePem).not.toContain("PRIVATE KEY");
      expect(signer.certificatePem).not.toContain(ca.keyPem.trim());
      signer.destroy();
    } finally {
      ca.cleanup();
    }
  });

  it("should fail closed for a missing row, wrong point, mismatched certificate, and bad tag", async () => {
    await testDb.db.executeQuery("DELETE FROM ca_keys");
    const ca = await createAgentCaFixture();
    try {
      await expect(
        CaSigner.load({ database: testDb.db, keyring, caPem: ca.certPem }),
      ).rejects.toBeInstanceOf(CaSignerUnavailableError);

      const id = await seedCaKey(testDb.db, keyring, ca);
      await testDb.db.executeQuery("UPDATE ca_keys SET public_key = :publicKey WHERE id = :id", {
        id,
        publicKey: Buffer.concat([Buffer.from([0x04]), randomBytes(64)]),
      });
      await expect(
        CaSigner.load({ database: testDb.db, keyring, caPem: ca.certPem }),
      ).rejects.toBeInstanceOf(CaSignerUnavailableError);

      await testDb.db.executeQuery("DELETE FROM ca_keys");
      const second = await createAgentCaFixture();
      try {
        await seedCaKey(testDb.db, keyring, ca);
        await testDb.db.executeQuery("UPDATE ca_keys SET cert_pem = :certPem", {
          certPem: second.certPem,
        });
        await expect(
          CaSigner.load({ database: testDb.db, keyring, caPem: ca.certPem }),
        ).rejects.toBeInstanceOf(CaSignerUnavailableError);
      } finally {
        second.cleanup();
      }

      await testDb.db.executeQuery("DELETE FROM ca_keys");
      await seedCaKey(testDb.db, keyring, ca);
      await testDb.db.executeQuery("UPDATE ca_keys SET wrap_tag = :tag", {
        tag: randomBytes(16),
      });
      let message = "";
      try {
        await CaSigner.load({ database: testDb.db, keyring, caPem: ca.certPem });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("Internal certificate authority is unavailable");
      expect(message).not.toContain(ca.scalar.toString("hex"));

      await testDb.db.executeQuery("DELETE FROM ca_keys");
      await seedCaKey(testDb.db, keyring, ca);
      await expect(
        testDb.db.executeQuery(
          `INSERT INTO ca_keys
             (id, cert_pem, public_key, wrapped_key, wrap_nonce, wrap_tag, kek_id,
              status, activated_at)
           VALUES
             (:id, :certPem, :publicKey, :wrappedKey, :wrapNonce, :wrapTag, :kekId,
              'current', now())`,
          {
            id: newUlid(),
            certPem: ca.certPem,
            publicKey: ca.publicPoint,
            wrappedKey: randomBytes(32),
            wrapNonce: randomBytes(12),
            wrapTag: randomBytes(16),
            kekId: "k1",
          },
        ),
      ).rejects.toThrow(/duplicate key|unique/i);
    } finally {
      ca.cleanup();
    }
  });
});

describe("CSR validation", () => {
  it("should accept arbitrary, empty, and whitespace-only subjects", async () => {
    for (const subject of ["CN=payments", "", "   "]) {
      const csr = await createAgentCsr({ subject });
      const parsed = await parseAgentCsr(csr.csrPem);
      expect(parsed.publicKeySha256).toBe(csr.publicKeySha256);
      expect(parsed.publicKeySha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("should reject malformed input and a modified signature", async () => {
    await expect(parseAgentCsr("not a certificate request")).rejects.toMatchObject({
      reason: "malformed",
    });
    await expect(parseAgentCsr("")).rejects.toMatchObject({ reason: "malformed" });

    const valid = await createAgentCsr();
    const der = Buffer.from(new x509.Pkcs10CertificateRequest(valid.csrPem).rawData);
    der[der.length - 1] = (der[der.length - 1] ?? 0) ^ 0x01;
    await expect(parseAgentCsr(der.toString("base64"))).rejects.toBeInstanceOf(CsrValidationError);
  });

  it("should reject RSA, P-384, and extension-bearing CSRs", async () => {
    const rsa = await globalThis.crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const rsaCsr = await createAgentCsr({
      keys: rsa,
      signingAlgorithm: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    });
    await expect(parseAgentCsr(rsaCsr.csrPem)).rejects.toMatchObject({ reason: "not_p256" });

    const p384 = await globalThis.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-384" },
      true,
      ["sign", "verify"],
    );
    const p384Csr = await createAgentCsr({
      keys: p384,
      signingAlgorithm: { name: "ECDSA", hash: "SHA-384" },
    });
    await expect(parseAgentCsr(p384Csr.csrPem)).rejects.toMatchObject({ reason: "not_p256" });

    const withExtension = await createAgentCsr({
      extensions: [new x509.BasicConstraintsExtension(false)],
    });
    await expect(parseAgentCsr(withExtension.csrPem)).rejects.toMatchObject({
      reason: "extensions_not_allowed",
    });
  });
});

describe("certificate profile rejection", () => {
  it("should reject a certificate with the wrong identity SAN", async () => {
    const ca = await currentCa();
    try {
      const signer = await CaSigner.load({
        database: testDb.db,
        keyring,
        caPem: ca.certPem,
        now: () => FIXED_NOW,
      });
      const csr = await createAgentCsr();
      const issued = await signer.issueClientCertificate(csr, PRINCIPAL, 30);
      await expect(
        verifyAgentCertificateProfile(issued.certificatePem, ca.cert, "01ARZ3NDEKTSV4RRFFQ69G5FAW"),
      ).rejects.toThrow();
      signer.destroy();
    } finally {
      ca.cleanup();
    }
  });
});
