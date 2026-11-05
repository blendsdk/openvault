import "reflect-metadata";
import { createPrivateKey } from "node:crypto";
import type { CertificateKeyType } from "@openvault/api-contract";
import * as x509 from "@peculiar/x509";

const DAY_MS = 86_400_000;

/** One generated key pair plus its PKCS#8 material. */
export interface CertificateKeyMaterial {
  readonly keys: CryptoKeyPair;
  readonly privateKeyPem: string;
}

/** A self-signed certificate and its matching private key. */
export interface SelfSignedFixture {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly keyType: CertificateKeyType;
}

/** A leaf, its private key, and the supplied chain. */
export interface ChainFixture {
  readonly leafPem: string;
  readonly chainPem: string;
  readonly privateKeyPem: string;
  readonly rootPem: string;
  readonly intermediatePem: string;
}

/** Generates a WebCrypto key pair for one profile. */
async function generateKeys(keyType: CertificateKeyType): Promise<CertificateKeyMaterial> {
  let keys: CryptoKeyPair;
  if (keyType === "ec-p256") {
    keys = (await globalThis.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
  } else {
    keys = (await globalThis.crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: keyType === "rsa-3072" ? 3072 : 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
  }
  const der = Buffer.from(await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const pem = createPrivateKey({ key: der, format: "der", type: "pkcs8" }).export({
    format: "pem",
    type: "pkcs8",
  });
  if (typeof pem !== "string") {
    throw new Error("Private key export failed");
  }
  return { keys, privateKeyPem: pem };
}

/** Formats one DER buffer as PEM for test fixtures. */
export function testPem(label: string, der: Buffer): string {
  const body = der.toString("base64");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

/** Creates one self-signed certificate with explicit dates. */
export async function createSelfSignedFixture(
  options: {
    readonly keyType?: CertificateKeyType;
    readonly subject?: string;
    readonly sans?: readonly string[];
    readonly notBefore?: Date;
    readonly notAfter?: Date;
    readonly now?: number;
  } = {},
): Promise<SelfSignedFixture> {
  const keyType = options.keyType ?? "ec-p256";
  const now = options.now ?? Date.now();
  const { keys, privateKeyPem } = await generateKeys(keyType);
  const notBefore = options.notBefore ?? new Date(now - DAY_MS);
  const notAfter = options.notAfter ?? new Date(now + 365 * DAY_MS);
  const sans = options.sans ?? ["DNS:fixture.example.test"];
  const rsa = keyType !== "ec-p256";
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    name: options.subject ?? "CN=fixture.example.test",
    keys,
    serialNumber: "01",
    notBefore,
    notAfter,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(
        rsa
          ? x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment
          : x509.KeyUsageFlags.digitalSignature,
        true,
      ),
      new x509.SubjectAlternativeNameExtension(
        sans.map((san) => {
          const separator = san.indexOf(":");
          const type = san.slice(0, separator);
          const value = san.slice(separator + 1);
          return {
            type: type === "URI" ? "url" : (type.toLowerCase() as "dns" | "ip" | "url" | "email"),
            value,
          };
        }),
        false,
      ),
    ],
  });
  return { certificatePem: certificate.toString("pem"), privateKeyPem, keyType };
}

/** Creates a root -> intermediate -> leaf chain and the leaf private key. */
export async function createChainFixture(
  options: {
    readonly now?: number;
    readonly leafKeyType?: CertificateKeyType;
    readonly leafSubject?: string;
    readonly leafSans?: readonly string[];
    readonly leafNotBefore?: Date;
    readonly leafNotAfter?: Date;
    readonly intermediateNotBefore?: Date;
    readonly intermediateNotAfter?: Date;
    readonly intermediateCa?: boolean;
    readonly intermediateKeyUsage?: number;
  } = {},
): Promise<ChainFixture> {
  const now = options.now ?? Date.now();
  const leafKeyType = options.leafKeyType ?? "ec-p256";
  const rootKeys = await generateKeys("ec-p256");
  const intermediateKeys = await generateKeys("ec-p256");
  const leafKeys = await generateKeys(leafKeyType);
  const notBefore = new Date(now - DAY_MS);
  const notAfter = new Date(now + 365 * DAY_MS);
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    name: "CN=Fixture Root",
    keys: rootKeys.keys,
    serialNumber: "1001",
    notBefore,
    notAfter,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
    ],
  });
  const intermediateCa = options.intermediateCa ?? true;
  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: "1002",
    subject: "CN=Fixture Intermediate",
    issuer: root.subject,
    notBefore: options.intermediateNotBefore ?? notBefore,
    notAfter: options.intermediateNotAfter ?? notAfter,
    publicKey: intermediateKeys.keys.publicKey,
    signingKey: rootKeys.keys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(intermediateCa, undefined, true),
      new x509.KeyUsagesExtension(
        options.intermediateKeyUsage ??
          (intermediateCa
            ? x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign
            : x509.KeyUsageFlags.digitalSignature),
        true,
      ),
    ],
  });
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "1003",
    subject: options.leafSubject ?? "CN=leaf.example.test",
    issuer: intermediate.subject,
    notBefore: options.leafNotBefore ?? notBefore,
    notAfter: options.leafNotAfter ?? notAfter,
    publicKey: leafKeys.keys.publicKey,
    signingKey: intermediateKeys.keys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.SubjectAlternativeNameExtension(
        (options.leafSans ?? ["DNS:leaf.example.test"]).map((san) => {
          const separator = san.indexOf(":");
          return {
            type: (san.slice(0, separator) === "URI"
              ? "url"
              : san.slice(0, separator).toLowerCase()) as "dns" | "ip" | "url" | "email",
            value: san.slice(separator + 1),
          };
        }),
        false,
      ),
    ],
  });
  return {
    leafPem: leaf.toString("pem"),
    chainPem: `${intermediate.toString("pem")}\n${root.toString("pem")}`,
    privateKeyPem: leafKeys.privateKeyPem,
    rootPem: root.toString("pem"),
    intermediatePem: intermediate.toString("pem"),
  };
}

/** Returns a leaf and a private key that do not match. */
export async function createMismatchedFixture(): Promise<{
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}> {
  const leaf = await createSelfSignedFixture({ keyType: "ec-p256" });
  const other = await createSelfSignedFixture({ keyType: "ec-p256" });
  return { certificatePem: leaf.certificatePem, privateKeyPem: other.privateKeyPem };
}

/** Returns a leaf and a chain certificate that claims the issuer but has the wrong key. */
export async function createInvalidChainFixture(): Promise<{
  readonly certificatePem: string;
  readonly chainPem: string;
  readonly privateKeyPem: string;
}> {
  const valid = await createChainFixture();
  const fake = await generateKeys("ec-p256");
  const now = Date.now();
  const fakeIntermediate = await x509.X509CertificateGenerator.createSelfSigned({
    name: "CN=Fixture Intermediate",
    keys: fake.keys,
    serialNumber: "2001",
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + 365 * DAY_MS),
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  return {
    certificatePem: valid.leafPem,
    chainPem: fakeIntermediate.toString("pem"),
    privateKeyPem: valid.privateKeyPem,
  };
}

/** Returns a not-yet-valid self-signed leaf. */
export async function createNotYetValidFixture(now: number): Promise<SelfSignedFixture> {
  return createSelfSignedFixture({
    now,
    notBefore: new Date(now + DAY_MS),
    notAfter: new Date(now + 30 * DAY_MS),
  });
}

/** Returns an expired self-signed leaf. */
export async function createExpiredFixture(now: number): Promise<SelfSignedFixture> {
  return createSelfSignedFixture({
    now,
    notBefore: new Date(now - 30 * DAY_MS),
    notAfter: new Date(now - DAY_MS),
  });
}

/** Returns a PKCS#1 private key body under a `PRIVATE KEY` label. */
export async function createPkcs1BodyFixture(): Promise<{
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}> {
  const fixture = await createSelfSignedFixture({ keyType: "rsa-2048" });
  const key = createPrivateKey({ key: fixture.privateKeyPem, format: "pem" });
  const der = key.export({ format: "der", type: "pkcs1" });
  if (!Buffer.isBuffer(der)) {
    throw new Error("PKCS#1 export failed");
  }
  return { certificatePem: fixture.certificatePem, privateKeyPem: testPem("PRIVATE KEY", der) };
}

/** Returns an Ed25519 PKCS#8 key with an unrelated certificate. */
export async function createEd25519Fixture(): Promise<{
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}> {
  const fixture = await createSelfSignedFixture({ keyType: "ec-p256" });
  const { privateKey } = await import("node:crypto").then(({ generateKeyPairSync }) =>
    generateKeyPairSync("ed25519"),
  );
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  if (typeof pem !== "string") {
    throw new Error("Ed25519 export failed");
  }
  return { certificatePem: fixture.certificatePem, privateKeyPem: pem };
}
