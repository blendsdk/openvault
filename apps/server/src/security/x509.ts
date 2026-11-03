import "reflect-metadata";
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import * as x509 from "@peculiar/x509";

/** The reviewed X.509 implementation re-exported to the rest of the server. */
export { x509 };

/** Parsed certificate type used by the CA signer boundary. */
export type CaCertificate = x509.X509Certificate;

/** The only public-key algorithm accepted for an agent certificate. */
const AGENT_CURVE = "prime256v1";

/** Maximum CSR envelope accepted by the shared contract. */
const MAX_CSR_LENGTH = 65_536;

/** Clock skew allowed before a freshly issued certificate becomes valid. */
const NOT_BEFORE_SKEW_MS = 30_000;

/** Days converted to milliseconds without floating-point arithmetic. */
const DAY_MS = 86_400_000;

/** Why a certificate signing request was rejected. */
export type CsrValidationReason =
  | "malformed"
  | "bad_signature"
  | "not_p256"
  | "extensions_not_allowed";

/** Raised when a CSR cannot be used for a fixed-profile agent certificate. */
export class CsrValidationError extends Error {
  /** Stable reason used by tests and the controller mapping. */
  public readonly reason: CsrValidationReason;

  /**
   * @param reason - Why the CSR was rejected.
   */
  public constructor(reason: CsrValidationReason) {
    super("Certificate signing request is not acceptable");
    this.name = "CsrValidationError";
    this.reason = reason;
  }
}

/** A verified agent CSR. The subject is deliberately not retained. */
export interface AgentCsr {
  /** Parsed P-256 public key from the CSR. */
  readonly publicKey: x509.PublicKey;
  /** SHA-256 over the SubjectPublicKeyInfo DER. */
  readonly publicKeySha256: string;
}

/** Material returned after issuing one agent certificate. */
export interface IssuedCertificate {
  /** Leaf certificate in PEM form. */
  readonly certificatePem: string;
  /** Lowercase hexadecimal serial assigned by the generator. */
  readonly serial: string;
  /** SHA-256 over the certificate DER, lowercase hex. */
  readonly fingerprint: string;
  /** Validity start written into the certificate. */
  readonly notBefore: Date;
  /** Validity end written into the certificate. */
  readonly notAfter: Date;
}

/** Options for one fixed-profile certificate issuance. */
export interface IssueAgentCertificateOptions {
  /** Verified CSR public key. */
  readonly publicKey: x509.PublicKey;
  /** Service principal identifier used as the subject common name. */
  readonly principalId: string;
  /** Parsed internal CA certificate. */
  readonly caCertificate: x509.X509Certificate;
  /** Non-extractable CA signing key. */
  readonly signingKey: CryptoKey;
  /** Total configured lifetime in days. */
  readonly ttlDays: number;
  /** Injectable clock in milliseconds since the Unix epoch. */
  readonly now?: number;
  /** Test-only deterministic serial source. */
  readonly serialSource?: () => string;
}

/** Computes lowercase SHA-256 hex over a buffer. */
function sha256Hex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Converts one base64url JWK coordinate into a fixed-length buffer. */
function jwkCoordinate(value: string | undefined): Buffer | undefined {
  if (value === undefined) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 ? decoded : undefined;
}

/**
 * Extracts the uncompressed P-256 point from a SubjectPublicKeyInfo buffer.
 *
 * Node exposes public keys as SPKI. The CA row stores the 65-byte uncompressed
 * point, so the two representations need an explicit conversion before they
 * can be compared.
 *
 * @param spki - DER SubjectPublicKeyInfo.
 * @returns `0x04 || x || y`, or undefined when the key is not P-256.
 */
export function p256PointFromSpki(spki: Buffer): Buffer | undefined {
  try {
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== AGENT_CURVE) {
      return undefined;
    }
    const jwk = key.export({ format: "jwk" });
    const x = jwkCoordinate(jwk.x);
    const y = jwkCoordinate(jwk.y);
    if (x === undefined || y === undefined) {
      return undefined;
    }
    return Buffer.concat([Buffer.from([0x04]), x, y]);
  } catch {
    return undefined;
  }
}

/**
 * Parses and verifies one agent certificate signing request.
 *
 * The request must be a bounded PEM/DER CSR with a valid proof of possession,
 * an EC P-256 key, and no extensions. The subject is accepted in any form and
 * never copied into the issued certificate.
 *
 * @param csrPem - CSR envelope from the agent.
 * @returns The verified public key and its SPKI hash.
 * @throws {CsrValidationError} When the CSR is malformed or outside the profile.
 */
export async function parseAgentCsr(csrPem: string): Promise<AgentCsr> {
  if (typeof csrPem !== "string" || csrPem.length === 0 || csrPem.length > MAX_CSR_LENGTH) {
    throw new CsrValidationError("malformed");
  }

  let request: x509.Pkcs10CertificateRequest;
  try {
    request = new x509.Pkcs10CertificateRequest(csrPem);
  } catch {
    throw new CsrValidationError("malformed");
  }

  let verified: boolean;
  try {
    verified = await request.verify();
  } catch {
    throw new CsrValidationError("bad_signature");
  }
  if (!verified) {
    throw new CsrValidationError("bad_signature");
  }

  if (request.extensions.length > 0) {
    throw new CsrValidationError("extensions_not_allowed");
  }

  const spki = Buffer.from(request.publicKey.rawData);
  if (p256PointFromSpki(spki) === undefined) {
    throw new CsrValidationError("not_p256");
  }

  return {
    publicKey: request.publicKey,
    publicKeySha256: sha256Hex(spki),
  };
}

/**
 * Normalizes a serial supplied by a deterministic test source.
 *
 * @param value - Raw hexadecimal serial.
 * @returns Lowercase hexadecimal without a `0x` prefix.
 * @throws {Error} When the value is not a bounded hexadecimal string.
 */
export function normalizeSerial(value: string): string {
  const normalized = value.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{1,40}$/.test(normalized)) {
    throw new Error("Serial source must return hexadecimal digits");
  }
  return BigInt(`0x${normalized}`).toString(16);
}

/**
 * Issues one certificate with the fixed agent profile.
 *
 * The subject is `CN=<principal id>`, the certificate is a non-CA client
 * certificate with one identity URI SAN, and the CA private key never leaves
 * the caller. The returned serial is read from the generated certificate.
 *
 * @param options - CSR key, identity, CA material, lifetime, and clock seams.
 * @returns PEM, serial, fingerprint, and validity dates.
 */
export async function issueAgentCertificate(
  options: IssueAgentCertificateOptions,
): Promise<IssuedCertificate> {
  const now = options.now ?? Date.now();
  const notBefore = new Date(now - NOT_BEFORE_SKEW_MS);
  const notAfter = new Date(notBefore.getTime() + options.ttlDays * DAY_MS);
  const requestedSerial = options.serialSource?.() ?? randomBytes(16).toString("hex");
  const serialNumber = normalizeSerial(requestedSerial);

  const certificate = await x509.X509CertificateGenerator.create({
    serialNumber,
    subject: `CN=${options.principalId}`,
    issuer: options.caCertificate.subject,
    notBefore,
    notAfter,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    publicKey: options.publicKey,
    signingKey: options.signingKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], false),
      new x509.SubjectAlternativeNameExtension(
        [{ type: "url", value: `openvault://identity/${options.principalId}` }],
        false,
      ),
    ],
  });

  return {
    certificatePem: certificate.toString("pem"),
    serial: certificate.serialNumber.toLowerCase(),
    fingerprint: sha256Hex(Buffer.from(certificate.rawData)),
    notBefore: certificate.notBefore,
    notAfter: certificate.notAfter,
  };
}

/**
 * Verifies a generated agent certificate against the internal CA and profile.
 *
 * This is used by the readiness probe and by tests. It checks the signature,
 * issuer, subject, CA flag, key usage, client-auth EKU, and identity SAN.
 *
 * @param certificatePem - Leaf certificate to check.
 * @param caCertificate - Trusted internal CA.
 * @param principalId - Expected service principal identifier.
 * @throws {Error} When any profile element is wrong.
 */
export async function verifyAgentCertificateProfile(
  certificatePem: string,
  caCertificate: x509.X509Certificate,
  principalId: string,
): Promise<void> {
  const certificate = new x509.X509Certificate(certificatePem);
  if (!(await certificate.verify({ publicKey: caCertificate.publicKey }))) {
    throw new Error("agent certificate signature does not verify");
  }
  if (certificate.issuer !== caCertificate.subject) {
    throw new Error("agent certificate issuer does not match the internal CA");
  }
  if (certificate.subject !== `CN=${principalId}`) {
    throw new Error("agent certificate subject does not match the identity");
  }

  const basicConstraints = certificate.getExtension(x509.BasicConstraintsExtension);
  if (basicConstraints === null || basicConstraints.ca) {
    throw new Error("agent certificate must not be a CA");
  }
  const keyUsages = certificate.getExtension(x509.KeyUsagesExtension);
  if (keyUsages === null || (keyUsages.usages & x509.KeyUsageFlags.digitalSignature) === 0) {
    throw new Error("agent certificate must allow digital signatures");
  }
  const extendedKeyUsage = certificate.getExtension(x509.ExtendedKeyUsageExtension);
  if (
    extendedKeyUsage === null ||
    !extendedKeyUsage.usages.includes(x509.ExtendedKeyUsage.clientAuth)
  ) {
    throw new Error("agent certificate must allow client authentication");
  }

  const names = certificate.getExtension(x509.SubjectAlternativeNameExtension)?.names;
  const urls = names?.items.filter((name) => name.type === "url") ?? [];
  if (urls.length !== 1 || urls[0]?.value !== `openvault://identity/${principalId}`) {
    throw new Error("agent certificate must contain exactly one identity SAN");
  }
}
