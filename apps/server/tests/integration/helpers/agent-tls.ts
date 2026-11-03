import { createHash, createPrivateKey, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import { wrapCaScalar } from "../../../src/security/ca.js";
import type { KeyringProvider } from "../../../src/security/keyring.js";
import { x509 } from "../../../src/security/x509.js";

/** One disposable EC P-256 internal CA. */
export interface AgentCaFixture {
  readonly cert: x509.X509Certificate;
  readonly certPem: string;
  readonly certPath: string;
  readonly keys: CryptoKeyPair;
  /** Uncompressed `0x04 || x || y` public point. */
  readonly publicPoint: Buffer;
  /** 32-byte private scalar. */
  readonly scalar: Buffer;
  cleanup(): void;
}

/** Key material and CSR generated for one agent request. */
export interface AgentCsrFixture {
  readonly csrPem: string;
  readonly keys: CryptoKeyPair;
  readonly publicKey: x509.PublicKey;
  readonly publicKeySha256: string;
  readonly publicKeySpki: Buffer;
}

/** Client certificate and private key for the agent listener. */
export interface AgentClientFixture {
  readonly certPem: string;
  readonly keyPem: string;
  readonly fingerprint: string;
  readonly publicKeySha256: string;
  readonly certificate: x509.X509Certificate;
  readonly keys: CryptoKeyPair;
}

/** Computes lowercase SHA-256 hex. */
export function sha256Hex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Generates an extractable P-256 key pair. */
export async function generateP256Keys(): Promise<CryptoKeyPair> {
  return globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
}

/** Extracts the 32-byte scalar and 65-byte point from a P-256 private key. */
async function privateKeyMaterial(keys: CryptoKeyPair): Promise<{
  scalar: Buffer;
  publicPoint: Buffer;
}> {
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", keys.privateKey);
  if (jwk.d === undefined || jwk.x === undefined || jwk.y === undefined) {
    throw new Error("P-256 key export did not contain the expected coordinates");
  }
  return {
    scalar: Buffer.from(jwk.d, "base64url"),
    publicPoint: Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from(jwk.y, "base64url"),
    ]),
  };
}

/**
 * Generates a disposable P-256 internal CA and writes its PEM to a temp file.
 *
 * @returns CA certificate, key pair, scalar, public point, and cleanup.
 */
export async function createAgentCaFixture(): Promise<AgentCaFixture> {
  const directory = mkdtempSync(join(tmpdir(), "openvault-agent-ca-"));
  const certPath = join(directory, "internal-ca.pem");
  const keys = await generateP256Keys();
  const now = Date.now();
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString("hex"),
    name: "CN=OpenVault Internal CA",
    keys,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
    ],
  });
  const certPem = certificate.toString("pem");
  writeFileSync(certPath, certPem, { mode: 0o600 });
  chmodSync(certPath, 0o600);
  const material = await privateKeyMaterial(keys);

  return {
    cert: certificate,
    certPem,
    certPath,
    keys,
    publicPoint: material.publicPoint,
    scalar: material.scalar,
    cleanup(): void {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Seeds the single current CA row through the production wrapping function.
 *
 * @param database - Migrated test database.
 * @param keyring - Loaded keyring.
 * @param ca - CA fixture.
 * @returns The inserted row id.
 */
export async function seedCaKey(
  database: PostgreSQLDatabase,
  keyring: KeyringProvider,
  ca: AgentCaFixture,
): Promise<string> {
  const id = newUlid();
  const wrapped = wrapCaScalar(keyring, id, ca.scalar);
  await database.executeQuery(
    `INSERT INTO ca_keys
       (id, cert_pem, public_key, wrapped_key, wrap_nonce, wrap_tag, kek_id,
        status, activated_at, retired_at)
     VALUES
       (:id, :certPem, :publicKey, :wrappedKey, :wrapNonce, :wrapTag, :kekId,
        'current', now(), NULL)`,
    {
      id,
      certPem: ca.certPem,
      publicKey: ca.publicPoint,
      wrappedKey: wrapped.wrappedKey,
      wrapNonce: wrapped.wrapNonce,
      wrapTag: wrapped.wrapTag,
      kekId: wrapped.kekId,
    },
  );
  return id;
}

/**
 * Generates a CSR with the requested key algorithm and optional extensions.
 *
 * @param options - Key pair, subject, extensions, and algorithm override.
 * @returns CSR PEM, keys, and SPKI hash.
 */
export async function createAgentCsr(
  options: {
    readonly keys?: CryptoKeyPair;
    readonly subject?: string;
    readonly extensions?: x509.Extension[];
    readonly signingAlgorithm?: Algorithm | EcdsaParams;
  } = {},
): Promise<AgentCsrFixture> {
  const keys = options.keys ?? (await generateP256Keys());
  const algorithm = options.signingAlgorithm ?? { name: "ECDSA", hash: "SHA-256" };
  const request = await x509.Pkcs10CertificateRequestGenerator.create({
    name: options.subject ?? "CN=agent",
    keys,
    signingAlgorithm: algorithm,
    ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
  });
  return {
    csrPem: request.toString("pem"),
    keys,
    publicKey: request.publicKey,
    publicKeySha256: sha256Hex(Buffer.from(request.publicKey.rawData)),
    publicKeySpki: Buffer.from(request.publicKey.rawData),
  };
}

/**
 * Creates a P-256 client certificate signed by the fixture CA.
 *
 * @param ca - Internal CA fixture.
 * @param principalId - Service principal used as the subject.
 * @param options - Optional validity overrides.
 * @returns PEM material, fingerprints, and parsed certificate.
 */
export async function createAgentClientCertificate(
  ca: AgentCaFixture,
  principalId: string,
  options: {
    readonly notBefore?: Date;
    readonly notAfter?: Date;
    readonly keys?: CryptoKeyPair;
  } = {},
): Promise<AgentClientFixture> {
  const keys = options.keys ?? (await generateP256Keys());
  const now = Date.now();
  const certificate = await x509.X509CertificateGenerator.create({
    serialNumber: randomBytes(16).toString("hex"),
    subject: `CN=${principalId}`,
    issuer: ca.cert.subject,
    notBefore: options.notBefore ?? new Date(now - 60_000),
    notAfter: options.notAfter ?? new Date(now + 86_400_000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    publicKey: keys.publicKey,
    signingKey: ca.keys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], false),
      new x509.SubjectAlternativeNameExtension([
        { type: "url", value: `openvault://identity/${principalId}` },
      ]),
    ],
  });
  const privateKeyDer = await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey);
  const exportedKey = createPrivateKey({
    key: Buffer.from(privateKeyDer),
    format: "der",
    type: "pkcs8",
  }).export({ format: "pem", type: "pkcs8" });
  const keyPem = typeof exportedKey === "string" ? exportedKey : exportedKey.toString("utf8");
  const raw = Buffer.from(certificate.rawData);
  return {
    certPem: certificate.toString("pem"),
    keyPem,
    fingerprint: sha256Hex(raw),
    publicKeySha256: sha256Hex(Buffer.from(certificate.publicKey.rawData)),
    certificate,
    keys,
  };
}

/** Returns a deterministic lowercase serial source seeded from a counter. */
export function serialSource(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index] ?? values[values.length - 1] ?? "0";
    index += 1;
    return value;
  };
}
