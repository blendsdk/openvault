import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { isIP } from "node:net";
import type { CertificateKeyType, CertificateWarning } from "@openvault/api-contract";
import { x509 } from "../security/x509.js";
import { CertificateServiceError } from "./errors.js";

const DAY_MS = 86_400_000;
const MAX_PRIVATE_KEY_BYTES = 16_384;
const MAX_SANS = 100;
const MAX_SAN_TEXT = 8_192;
const P256_CURVE = "prime256v1";
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
const DNS_PATTERN =
  /^(?:\*\.)?(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** One normalized PEM block. */
export interface PemBlock {
  /** Uppercase PEM label. */
  readonly label: string;
  /** Canonical base64 body without line breaks. */
  readonly body: string;
  /** Normalized PEM text. */
  readonly pem: string;
  /** Decoded DER bytes. */
  readonly der: Buffer;
}

/** Parsed certificate material ready for encryption and persistence. */
export interface ParsedCertificateMaterial {
  /** Normalized leaf certificate. */
  readonly leafPem: string;
  /** Normalized leaf plus used non-leaf blocks. */
  readonly certificateChainPem: string;
  /** Number of blocks in the stored chain. */
  readonly chainLength: number;
  /** Non-fatal import warnings. */
  readonly warnings: readonly CertificateWarning[];
  /** Leaf subject. */
  readonly subject: string;
  /** Canonical typed leaf SANs. */
  readonly sans: readonly string[];
  /** Leaf issuer. */
  readonly issuer: string;
  /** Lowercase hexadecimal serial. */
  readonly serial: string;
  /** Lowercase hexadecimal SHA-256 fingerprint. */
  readonly fingerprint: string;
  /** Validity start. */
  readonly notBefore: Date;
  /** Validity end. */
  readonly notAfter: Date;
  /** Normalized PKCS#8 PEM. */
  readonly privateKeyPem: string;
  /** PKCS#8 DER. The caller must zero this after encryption. */
  readonly privateKeyBytes: Buffer;
  /** Validated key profile. */
  readonly privateKeyType: CertificateKeyType;
}

/** Wraps a decoded DER body in canonical PEM armor. */
function armor(label: string, body: string): string {
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

/** Rejects control characters in identity text. */
function hasControlCharacters(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

/**
 * Parses strict PEM blocks from one input string.
 *
 * Non-whitespace outside blocks is rejected, every label must be allowlisted, every body
 * must be canonical base64, and the total input is bounded before any DER work.
 *
 * @param input - PEM text.
 * @param options - Byte bound and allowed labels.
 * @returns Normalized blocks in input order.
 * @throws {CertificateServiceError} 413 for an oversized input, 422 for malformed PEM.
 */
export function parsePemBlocks(
  input: string,
  options: { readonly maximumBytes: number; readonly labels: readonly string[] },
): readonly PemBlock[] {
  if (Buffer.byteLength(input, "utf8") > options.maximumBytes) {
    throw new CertificateServiceError(
      413,
      "certificate_too_large",
      "Certificate material is too large",
    );
  }
  const normalized = input.replace(/\r\n/g, "\n");
  if (normalized.includes("\u0000")) {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
  const blocks: PemBlock[] = [];
  let success = false;
  let remainder = normalized;
  try {
    for (const match of normalized.matchAll(PEM_BLOCK)) {
      const label = match[1];
      const rawBody = match[2] ?? "";
      if (label === undefined || !options.labels.includes(label)) {
        throw new CertificateServiceError(422, "validation_error", "Validation failed");
      }
      const body = rawBody.replace(/\s+/g, "");
      if (body.length === 0 || !CANONICAL_BASE64.test(body)) {
        throw new CertificateServiceError(422, "validation_error", "Validation failed");
      }
      const der = Buffer.from(body, "base64");
      if (der.toString("base64") !== body) {
        der.fill(0);
        throw new CertificateServiceError(422, "validation_error", "Validation failed");
      }
      blocks.push({ label, body, pem: armor(label, body), der });
      remainder = remainder.replace(match[0], "");
    }
    if (remainder.trim().length > 0 || blocks.length === 0) {
      throw new CertificateServiceError(422, "validation_error", "Validation failed");
    }
    success = true;
    return blocks;
  } finally {
    if (!success) {
      for (const block of blocks) {
        block.der.fill(0);
      }
    }
  }
}

/** Canonicalizes one typed SAN and validates its grammar. */
export function canonicalizeSan(value: string): string {
  if (hasControlCharacters(value) || value.length > 2_048) {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
  const separator = value.indexOf(":");
  if (separator <= 0) {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
  const type = value.slice(0, separator);
  const body = value.slice(separator + 1);
  if (body.length === 0) {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
  switch (type) {
    case "DNS": {
      const lower = body.toLowerCase();
      if (!DNS_PATTERN.test(lower) || (lower.includes("*") && !lower.startsWith("*."))) {
        throw new CertificateServiceError(422, "validation_error", "Validation failed");
      }
      return `DNS:${lower}`;
    }
    case "IP": {
      if (isIP(body) === 0) {
        throw new CertificateServiceError(422, "validation_error", "Validation failed");
      }
      return `IP:${body}`;
    }
    case "URI": {
      let url: URL;
      try {
        url = new URL(body);
      } catch {
        throw new CertificateServiceError(422, "validation_error", "Validation failed");
      }
      if (url.username !== "" || url.password !== "" || url.protocol.length < 2) {
        throw new CertificateServiceError(422, "validation_error", "Validation failed");
      }
      return `URI:${body}`;
    }
    case "email": {
      if (body.length > 320 || !EMAIL_PATTERN.test(body)) {
        throw new CertificateServiceError(422, "validation_error", "Validation failed");
      }
      return `email:${body.toLowerCase()}`;
    }
    default:
      throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
}

/** Removes SAN duplicates case-insensitively while preserving the first spelling. */
export function uniqueSans(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

/** Returns true when a certificate verifies its own signature. */
async function isSelfSigned(certificate: x509.X509Certificate): Promise<boolean> {
  const verified = await certificate.verify({
    publicKey: certificate.publicKey,
    signatureOnly: true,
  });
  return verified && certificate.subject === certificate.issuer;
}

/** Rejects an intermediate without CA/keyCertSign. */
function assertIntermediate(certificate: x509.X509Certificate): void {
  const basic = certificate.getExtension(x509.BasicConstraintsExtension);
  if (basic === null || !basic.ca) {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
  const usage = certificate.getExtension(x509.KeyUsagesExtension);
  if (usage !== null && (usage.usages & x509.KeyUsageFlags.keyCertSign) === 0) {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
}

/** Reads canonical typed SANs from one certificate. */
function readSans(certificate: x509.X509Certificate): readonly string[] {
  let names: readonly x509.GeneralName[];
  try {
    names = certificate.getExtension(x509.SubjectAlternativeNameExtension)?.names.items ?? [];
  } catch {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
  const sans: string[] = [];
  for (const name of names) {
    switch (name.type) {
      case "dns":
        sans.push(canonicalizeSan(`DNS:${name.value}`));
        break;
      case "ip":
        sans.push(canonicalizeSan(`IP:${name.value}`));
        break;
      case "url":
        sans.push(canonicalizeSan(`URI:${name.value}`));
        break;
      case "email":
        sans.push(canonicalizeSan(`email:${name.value}`));
        break;
      default:
        throw new CertificateServiceError(422, "validation_error", "Validation failed");
    }
  }
  return uniqueSans(sans);
}

/** Validates one key and returns its profile plus its public KeyObject. */
function readPrivateKey(der: Buffer): {
  readonly key: ReturnType<typeof createPrivateKey>;
  readonly publicKey: ReturnType<typeof createPublicKey>;
  readonly keyType: CertificateKeyType;
} {
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
  const details = key.asymmetricKeyDetails;
  let keyType: CertificateKeyType;
  if (key.asymmetricKeyType === "rsa" && details?.modulusLength === 2048) {
    keyType = "rsa-2048";
  } else if (key.asymmetricKeyType === "rsa" && details?.modulusLength === 3072) {
    keyType = "rsa-3072";
  } else if (key.asymmetricKeyType === "ec" && details?.namedCurve === P256_CURVE) {
    keyType = "ec-p256";
  } else {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
  return { key, publicKey: createPublicKey(key), keyType };
}

/**
 * Parses, validates, and normalizes certificate import material.
 *
 * @param input - Leaf/chain/private-key PEM, date policy, clock, and size bound.
 * @returns Normalized material.
 * @throws {CertificateServiceError} 413 for oversized fields, 422 for any validation failure.
 */
export async function parseCertificateMaterial(input: {
  readonly certificatePem: string;
  readonly chainPem?: string;
  readonly privateKeyPem: string;
  readonly allowNotYetValid: boolean;
  readonly now: number;
  readonly maximumBytes: number;
}): Promise<ParsedCertificateMaterial> {
  if (Buffer.byteLength(input.privateKeyPem, "utf8") > MAX_PRIVATE_KEY_BYTES) {
    throw new CertificateServiceError(413, "certificate_too_large", "Private key is too large");
  }
  const leafBlocks = parsePemBlocks(input.certificatePem, {
    maximumBytes: input.maximumBytes,
    labels: ["CERTIFICATE"],
  });
  if (leafBlocks.length !== 1) {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
  const chainBlocks =
    input.chainPem === undefined || input.chainPem.trim() === ""
      ? []
      : parsePemBlocks(input.chainPem, {
          maximumBytes: input.maximumBytes,
          labels: ["CERTIFICATE"],
        });
  const keyBlocks = parsePemBlocks(input.privateKeyPem, {
    maximumBytes: MAX_PRIVATE_KEY_BYTES,
    labels: ["PRIVATE KEY"],
  });
  if (keyBlocks.length !== 1) {
    for (const block of keyBlocks) {
      block.der.fill(0);
    }
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
  const leafBlock = leafBlocks[0];
  const keyBlock = keyBlocks[0];
  if (leafBlock === undefined || keyBlock === undefined) {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
  if (
    Buffer.byteLength(leafBlock.pem, "utf8") +
      chainBlocks.reduce((total, block) => total + Buffer.byteLength(block.pem, "utf8"), 0) >
    input.maximumBytes
  ) {
    keyBlock.der.fill(0);
    throw new CertificateServiceError(
      413,
      "certificate_too_large",
      "Certificate material is too large",
    );
  }

  let leaf: x509.X509Certificate;
  let chain: x509.X509Certificate[];
  try {
    leaf = new x509.X509Certificate(leafBlock.pem);
    chain = chainBlocks.map((block) => new x509.X509Certificate(block.pem));
  } catch {
    keyBlock.der.fill(0);
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }

  try {
    const { publicKey, keyType } = readPrivateKey(keyBlock.der);
    const leafSpki = Buffer.from(leaf.publicKey.rawData);
    const keySpki = publicKey.export({ type: "spki", format: "der" });
    if (!leafSpki.equals(keySpki)) {
      throw new CertificateServiceError(422, "validation_error", "Validation failed");
    }

    const warnings: CertificateWarning[] = [];
    const usedChain: x509.X509Certificate[] = [];
    if (chain.length > 0) {
      const first = chain[0];
      if (first === undefined) {
        throw new CertificateServiceError(422, "validation_error", "Validation failed");
      }
      const verifiesLeaf = await leaf.verify({
        publicKey: first.publicKey,
        signatureOnly: true,
      });
      if (!verifiesLeaf) {
        if (leaf.issuer === first.subject) {
          throw new CertificateServiceError(422, "validation_error", "Validation failed");
        }
        warnings.push({
          code: "missing_intermediate",
          message: "The supplied chain does not contain the certificate issuer",
        });
      } else {
        usedChain.push(first);
        for (let index = 1; index < chain.length; index += 1) {
          const previous = chain[index - 1];
          const parent = chain[index];
          if (previous === undefined || parent === undefined) {
            break;
          }
          const verified = await previous.verify({
            publicKey: parent.publicKey,
            signatureOnly: true,
          });
          if (!verified) {
            if (previous.issuer === parent.subject) {
              throw new CertificateServiceError(422, "validation_error", "Validation failed");
            }
            warnings.push({
              code: "missing_intermediate",
              message: "The supplied chain has a gap",
            });
            break;
          }
          usedChain.push(parent);
        }
        for (const intermediate of usedChain) {
          assertIntermediate(intermediate);
          if (intermediate.notAfter.getTime() <= input.now) {
            warnings.push({
              code: "expired_intermediate",
              message: "A chain certificate has expired",
            });
          } else if (intermediate.notBefore.getTime() > input.now) {
            warnings.push({
              code: "not_yet_valid_intermediate",
              message: "A chain certificate is not yet valid",
            });
          }
        }
        const top = usedChain[usedChain.length - 1];
        if (top !== undefined && !(await isSelfSigned(top))) {
          warnings.push({
            code: "missing_intermediate",
            message: "The supplied chain does not reach a self-signed root",
          });
        }
      }
    } else if (!(await isSelfSigned(leaf))) {
      warnings.push({
        code: "missing_intermediate",
        message: "No intermediate chain was supplied",
      });
    }

    if (leaf.notBefore.getTime() > input.now && !input.allowNotYetValid) {
      throw new CertificateServiceError(422, "validation_error", "Validation failed");
    }
    if (leaf.notBefore.getTime() > input.now) {
      warnings.push({ code: "not_yet_valid", message: "Certificate is not yet valid" });
    }
    if (leaf.notAfter.getTime() <= input.now) {
      warnings.push({ code: "expired", message: "Certificate has expired" });
    }
    if (leaf.notAfter.getTime() <= leaf.notBefore.getTime()) {
      throw new CertificateServiceError(422, "validation_error", "Validation failed");
    }

    const subject = leaf.subject;
    const issuer = leaf.issuer;
    const serial = leaf.serialNumber.toLowerCase();
    if (
      subject.length > 1_024 ||
      issuer.length > 1_024 ||
      serial.length === 0 ||
      serial.length > 128
    ) {
      throw new CertificateServiceError(422, "validation_error", "Validation failed");
    }
    const sans = readSans(leaf);
    if (
      sans.length > MAX_SANS ||
      sans.reduce((total, value) => total + value.length, 0) > MAX_SAN_TEXT
    ) {
      throw new CertificateServiceError(422, "validation_error", "Validation failed");
    }
    const fingerprint = createHash("sha256").update(Buffer.from(leaf.rawData)).digest("hex");
    const chainPem = usedChain.map((certificate) => certificate.toString("pem")).join("\n");
    const certificateChainPem =
      chainPem.length === 0 ? leafBlock.pem : `${leafBlock.pem}\n${chainPem}`;

    return {
      leafPem: leafBlock.pem,
      certificateChainPem,
      chainLength: 1 + usedChain.length,
      warnings,
      subject,
      sans,
      issuer,
      serial,
      fingerprint,
      notBefore: leaf.notBefore,
      notAfter: leaf.notAfter,
      privateKeyPem: keyBlock.pem,
      privateKeyBytes: keyBlock.der,
      privateKeyType: keyType,
    };
  } catch (error) {
    keyBlock.der.fill(0);
    if (error instanceof CertificateServiceError) {
      throw error;
    }
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
}

/** Converts a stored chain back to leaf and non-leaf PEM. */
export function splitChainPem(chainPem: string): {
  readonly certificatePem: string;
  readonly chainPem: string;
  readonly chainLength: number;
} {
  const blocks = parsePemBlocks(chainPem, {
    maximumBytes: 131_072,
    labels: ["CERTIFICATE"],
  });
  const leaf = blocks[0];
  if (leaf === undefined) {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
  return {
    certificatePem: leaf.pem,
    chainPem: blocks
      .slice(1)
      .map((block) => block.pem)
      .join("\n"),
    chainLength: blocks.length,
  };
}

/** Converts one certificate date to milliseconds for callers that need it. */
export const CERTIFICATE_DAY_MS = DAY_MS;
