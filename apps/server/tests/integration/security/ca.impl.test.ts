import { createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { newUlid } from "@openvault/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CaSigner,
  CaSignerUnavailableError,
  publicPointFromScalar,
  unwrapCaScalar,
  wrapCaScalar,
} from "../../../src/security/ca.js";
import { KeyringProvider } from "../../../src/security/keyring.js";
import {
  normalizeSerial,
  p256PointFromSpki,
  parseAgentCsr,
  x509,
} from "../../../src/security/x509.js";
import { createAgentCaFixture, createAgentCsr, seedCaKey } from "../helpers/agent-tls.js";
import { createServerEnvironment, type ServerEnvironment } from "../helpers/server-environment.js";
import {
  applyMigrations,
  createTestDatabase,
  type TestDatabase,
} from "../helpers/test-database.js";

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

describe("CA scalar and point internals", () => {
  it("should reject every malformed wrap input and wrong KEK without leaking bytes", async () => {
    const ca = await createAgentCaFixture();
    try {
      expect(() => wrapCaScalar(keyring, newUlid(), Buffer.alloc(31))).toThrow(/32 bytes/);
      const id = newUlid();
      const wrapped = wrapCaScalar(keyring, id, ca.scalar);

      for (const input of [
        { ...wrapped, wrappedKey: randomBytes(33) },
        { ...wrapped, wrapNonce: randomBytes(11) },
        { ...wrapped, wrapTag: randomBytes(15) },
      ]) {
        expect(() => unwrapCaScalar(keyring, { id, ...input })).toThrow(/lengths/);
      }
      expect(() => unwrapCaScalar(keyring, { id, ...wrapped, kekId: "absent" })).toThrow();
    } finally {
      ca.cleanup();
    }
  });

  it("should derive the exact fixture point and reject non-P-256 SPKI values", async () => {
    const ca = await createAgentCaFixture();
    try {
      expect(publicPointFromScalar(ca.scalar).equals(ca.publicPoint)).toBe(true);
      expect(publicPointFromScalar(Buffer.alloc(32, 1)).length).toBe(65);

      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const rsaSpki = rsa.publicKey.export({ type: "spki", format: "der" });
      expect(p256PointFromSpki(rsaSpki)).toBeUndefined();
      expect(p256PointFromSpki(Buffer.from("not a key"))).toBeUndefined();
      expect(p256PointFromSpki(Buffer.from(ca.cert.publicKey.rawData))).toEqual(ca.publicPoint);
      expect(createPublicKey({ key: rsaSpki, format: "der", type: "spki" }).type).toBe("public");
    } finally {
      ca.cleanup();
    }
  });

  it("should normalize serial spelling and reject non-hex values", () => {
    expect(normalizeSerial("00ABCDEF")).toBe("abcdef");
    expect(normalizeSerial("0x00FF")).toBe("ff");
    expect(normalizeSerial("0001")).toBe("1");
    for (const value of ["", "xyz", "0x", "-1", "a".repeat(41)]) {
      expect(() => normalizeSerial(value)).toThrow();
    }
  });
});

describe("CA signer failure boundaries", () => {
  it("should reject a CA without pathlen zero and a destroyed signer", async () => {
    const ca = await createAgentCaFixture();
    const loose = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: randomBytes(16).toString("hex"),
      name: "CN=OpenVault Loose CA",
      keys: ca.keys,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 86_400_000),
      extensions: [
        new x509.BasicConstraintsExtension(true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
      ],
    });
    try {
      await testDb.db.executeQuery("DELETE FROM ca_keys");
      await seedCaKey(testDb.db, keyring, {
        ...ca,
        cert: loose,
        certPem: loose.toString("pem"),
        publicPoint: ca.publicPoint,
      });
      await expect(
        CaSigner.load({ database: testDb.db, keyring, caPem: loose.toString("pem") }),
      ).rejects.toBeInstanceOf(CaSignerUnavailableError);

      await testDb.db.executeQuery("DELETE FROM ca_keys");
      await seedCaKey(testDb.db, keyring, ca);
      const signer = await CaSigner.load({ database: testDb.db, keyring, caPem: ca.certPem });
      signer.destroy();
      const csr = await createAgentCsr();
      await expect(
        signer.issueClientCertificate(
          { publicKey: csr.publicKey, publicKeySha256: csr.publicKeySha256 },
          "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          30,
        ),
      ).rejects.toBeInstanceOf(CaSignerUnavailableError);
    } finally {
      ca.cleanup();
    }
  });

  it("should parse a DER-base64 CSR and hash its SPKI consistently", async () => {
    const csr = await createAgentCsr();
    const parsed = await parseAgentCsr(csr.csrPem);
    expect(parsed.publicKeySha256).toBe(csr.publicKeySha256);
    expect(parsed.publicKeySha256).toBe(
      (await import("node:crypto")).createHash("sha256").update(csr.publicKeySpki).digest("hex"),
    );
  });
});
