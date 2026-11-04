import { createHash, createPrivateKey, randomBytes } from "node:crypto";
import type { CertificateKeyType, CertificateWarning } from "@openvault/api-contract";
import { x509 } from "../security/x509.js";
import { CertificateServiceError } from "./errors.js";
import { canonicalizeSan } from "./pem.js";

const DAY_MS = 86_400_000;
const NOT_BEFORE_SKEW_MS = 30_000;

/** One generated self-signed certificate. */
export interface GeneratedCertificate {
  /** Public leaf certificate. */
  readonly certificatePem: string;
  /** PKCS#8 private key PEM. */
  readonly privateKeyPem: string;
  /** PKCS#8 DER. The caller must zero this after encryption. */
  readonly privateKeyBytes: Buffer;
  /** Key profile. */
  readonly keyType: CertificateKeyType;
  /** Subject. */
  readonly subject: string;
  /** Canonical typed SANs. */
  readonly sans: readonly string[];
  /** Lowercase hexadecimal serial. */
  readonly serial: string;
  /** Lowercase hexadecimal SHA-256 fingerprint. */
  readonly fingerprint: string;
  /** Validity start. */
  readonly notBefore: Date;
  /** Validity end. */
  readonly notAfter: Date;
  /** Warnings; generation currently produces none. */
  readonly warnings: readonly CertificateWarning[];
}

/** Maps a key profile to WebCrypto generation parameters. */
function keyAlgorithm(keyType: CertificateKeyType): {
  readonly algorithm: RsaHashedKeyGenParams | EcKeyGenParams;
  readonly usages: KeyUsage[];
} {
  switch (keyType) {
    case "rsa-2048":
      return {
        algorithm: {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        usages: ["sign", "verify"],
      };
    case "rsa-3072":
      return {
        algorithm: {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 3072,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        usages: ["sign", "verify"],
      };
    case "ec-p256":
      return {
        algorithm: { name: "ECDSA", namedCurve: "P-256" },
        usages: ["sign", "verify"],
      };
  }
}

/** Validates a subject as a non-empty RFC 4514 name. */
function assertSubject(subject: string): void {
  let name: x509.Name;
  try {
    name = new x509.Name(subject);
  } catch {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
  if (name.toJSON().length === 0 || subject.trim().length === 0) {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
}

/** Builds SAN extension entries from canonical typed strings. */
function sanEntries(sans: readonly string[]): x509.JsonGeneralName[] {
  return sans.map((san) => {
    const separator = san.indexOf(":");
    const type = san.slice(0, separator);
    const value = san.slice(separator + 1);
    switch (type) {
      case "DNS":
        return { type: "dns", value };
      case "IP":
        return { type: "ip", value };
      case "URI":
        return { type: "url", value };
      case "email":
        return { type: "email", value };
      default:
        throw new CertificateServiceError(422, "validation_error", "Validation failed");
    }
  });
}

/**
 * Generates one self-signed RSA or EC certificate.
 *
 * @param input - Subject, SANs, key profile, validity, and clock.
 * @returns Public certificate plus the encrypted-later private key material.
 * @throws {CertificateServiceError} 422 for an invalid subject or SAN.
 */
export async function generateSelfSignedCertificate(input: {
  readonly subject: string;
  readonly sans: readonly string[];
  readonly keyType: CertificateKeyType;
  readonly validityDays: number;
  readonly now: number;
}): Promise<GeneratedCertificate> {
  assertSubject(input.subject);
  const sans = [...new Set(input.sans.map(canonicalizeSan))];
  if (sans.length === 0) {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
  const { algorithm, usages } = keyAlgorithm(input.keyType);
  let keys: CryptoKeyPair;
  try {
    keys = (await globalThis.crypto.subtle.generateKey(algorithm, true, usages)) as CryptoKeyPair;
  } catch {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
  const notBefore = new Date(input.now - NOT_BEFORE_SKEW_MS);
  const notAfter = new Date(notBefore.getTime() + input.validityDays * DAY_MS);
  const serialNumber = randomBytes(16).toString("hex");
  const rsa = input.keyType !== "ec-p256";
  const keyUsage = rsa
    ? x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment
    : x509.KeyUsageFlags.digitalSignature;

  let certificate: x509.X509Certificate;
  try {
    certificate = await x509.X509CertificateGenerator.createSelfSigned({
      name: input.subject,
      keys,
      serialNumber,
      notBefore,
      notAfter,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(keyUsage, true),
        new x509.ExtendedKeyUsageExtension(
          [x509.ExtendedKeyUsage.serverAuth, x509.ExtendedKeyUsage.clientAuth],
          false,
        ),
        new x509.SubjectAlternativeNameExtension(sanEntries(sans), false),
      ],
    });
  } catch {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }

  let privateKeyBytes: Buffer;
  try {
    privateKeyBytes = Buffer.from(
      await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey),
    );
  } catch {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
  let privateKeyPem: string;
  try {
    const exported = createPrivateKey({
      key: privateKeyBytes,
      format: "der",
      type: "pkcs8",
    }).export({ format: "pem", type: "pkcs8" });
    if (typeof exported !== "string") {
      throw new Error("PKCS#8 PEM export failed");
    }
    privateKeyPem = exported;
  } catch {
    privateKeyBytes.fill(0);
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }

  return {
    certificatePem: certificate.toString("pem"),
    privateKeyPem,
    privateKeyBytes,
    keyType: input.keyType,
    subject: certificate.subject,
    sans,
    serial: certificate.serialNumber.toLowerCase(),
    fingerprint: createHash("sha256").update(Buffer.from(certificate.rawData)).digest("hex"),
    notBefore: certificate.notBefore,
    notAfter: certificate.notAfter,
    warnings: [],
  };
}
