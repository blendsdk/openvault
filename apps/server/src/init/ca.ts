import { randomBytes } from "node:crypto";
import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import { wrapCaScalar } from "../security/ca.js";
import type { KeyringProvider } from "../security/keyring.js";
import { p256PointFromSpki, x509 } from "../security/x509.js";
import { InitError } from "./errors.js";

interface CaRow {
  readonly id: string;
  readonly cert_pem: string;
  readonly public_key: Buffer;
  readonly wrapped_key: Buffer;
  readonly wrap_nonce: Buffer;
  readonly wrap_tag: Buffer;
  readonly kek_id: string;
}

/** Result of ensuring the internal CA. */
export interface EnsureCaResult {
  /** CA certificate PEM. */
  readonly certPem: string;
  /** True when this run created the CA. */
  readonly created: boolean;
}

/** Generates an extractable P-256 key pair. */
async function p256Keys(): Promise<CryptoKeyPair> {
  return globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]) as Promise<CryptoKeyPair>;
}

/** Extracts the scalar and point from a P-256 private key. */
async function keyMaterial(keys: CryptoKeyPair): Promise<{ scalar: Buffer; point: Buffer }> {
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", keys.privateKey);
  if (jwk.d === undefined || jwk.x === undefined || jwk.y === undefined) {
    throw new InitError("init_ca", "The generated CA key could not be exported");
  }
  const scalar = Buffer.from(jwk.d, "base64url");
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  if (scalar.length !== 32 || point.length !== 65) {
    scalar.fill(0);
    throw new InitError("init_ca", "The generated CA key has an invalid shape");
  }
  return { scalar, point };
}

/** Parses a CA certificate and verifies its public point. */
function validateCa(certPem: string, publicKey: Buffer): void {
  let certificate: x509.X509Certificate;
  try {
    certificate = new x509.X509Certificate(certPem);
  } catch {
    throw new InitError("init_ca", "The stored CA certificate is not valid PEM");
  }
  const point = p256PointFromSpki(Buffer.from(certificate.publicKey.rawData));
  if (point === undefined || !point.equals(publicKey)) {
    throw new InitError("init_ca", "The stored CA certificate does not match its public key");
  }
}

/**
 * Ensures one current internal CA row.
 *
 * @param database - Connected database.
 * @param keyring - Loaded keyring.
 * @param now - Clock.
 * @returns The CA PEM and whether it was created.
 */
export async function ensureCa(
  database: PostgreSQLDatabase,
  keyring: KeyringProvider,
  now: () => number,
): Promise<EnsureCaResult> {
  const current = await database.executeQuery<CaRow>(
    `SELECT id, cert_pem, public_key, wrapped_key, wrap_nonce, wrap_tag, kek_id
       FROM ca_keys
      WHERE status = 'current'
      LIMIT 1`,
  );
  const existing = current.records[0];
  if (existing !== undefined) {
    validateCa(existing.cert_pem, existing.public_key);
    return { certPem: existing.cert_pem, created: false };
  }

  const keys = await p256Keys();
  const material = await keyMaterial(keys);
  const timestamp = now();
  try {
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: randomBytes(16).toString("hex"),
      name: "CN=OpenVault Internal CA",
      keys,
      notBefore: new Date(timestamp - 60_000),
      notAfter: new Date(timestamp + 10 * 365 * 86_400_000),
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
          true,
        ),
      ],
    });
    const certPem = certificate.toString("pem");
    const id = newUlid();
    const wrapped = wrapCaScalar(keyring, id, material.scalar);
    try {
      await database.executeQuery(
        `INSERT INTO ca_keys
           (id, cert_pem, public_key, wrapped_key, wrap_nonce, wrap_tag, kek_id,
            status, activated_at)
         VALUES
           (:id, :certPem, :publicKey, :wrappedKey, :wrapNonce, :wrapTag, :kekId,
            'current', :activatedAt)`,
        {
          id,
          certPem,
          publicKey: material.point,
          wrappedKey: wrapped.wrappedKey,
          wrapNonce: wrapped.wrapNonce,
          wrapTag: wrapped.wrapTag,
          kekId: wrapped.kekId,
          activatedAt: new Date(timestamp),
        },
      );
    } catch (error) {
      if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "23505") {
        const raced = await database.executeQuery<CaRow>(
          `SELECT id, cert_pem, public_key, wrapped_key, wrap_nonce, wrap_tag, kek_id
             FROM ca_keys
            WHERE status = 'current'
            LIMIT 1`,
        );
        const row = raced.records[0];
        if (row !== undefined) {
          validateCa(row.cert_pem, row.public_key);
          return { certPem: row.cert_pem, created: false };
        }
      }
      throw error;
    }
    return { certPem, created: true };
  } finally {
    material.scalar.fill(0);
  }
}
