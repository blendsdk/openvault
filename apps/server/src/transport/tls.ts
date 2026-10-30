import { createPrivateKey, type KeyObject, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { OpenVaultConfig } from "../config/index.js";

/** Raised when TLS certificate, key, or CA material is missing or invalid. */
export class TlsMaterialError extends Error {
  /** Environment variable that owns the offending material. */
  public readonly key: string;

  public constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "TlsMaterialError";
    this.key = key;
  }
}

function readPem(key: string, path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new TlsMaterialError(key, "must reference a readable PEM file");
  }
}

function assertCurrentlyValid(key: string, certificate: X509Certificate): void {
  const now = Date.now();
  const from = Date.parse(certificate.validFrom);
  const to = Date.parse(certificate.validTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now > to) {
    throw new TlsMaterialError(key, "must be currently valid");
  }
}

/**
 * Validated TLS material for both listeners.
 *
 * The server certificate and private key must match, and the internal CA must
 * be a self-verifying CA certificate. Only the values Node needs are exposed;
 * no file contents or key material are logged.
 */
export class TlsMaterial {
  /** Server certificate chain PEM. The first certificate is the leaf. */
  public readonly certPem: string;
  /** Private key PEM accepted by the Node HTTPS server options. */
  public readonly keyPem: string;
  /** Parsed private key object. */
  public readonly keyObject: KeyObject;
  /** Internal CA certificate PEM. */
  public readonly caPem: string;
  /** Parsed leaf certificate. */
  public readonly certificate: X509Certificate;
  /** Parsed internal CA certificate. */
  public readonly caCertificate: X509Certificate;

  private constructor(
    certPem: string,
    keyPem: string,
    keyObject: KeyObject,
    caPem: string,
    certificate: X509Certificate,
    caCertificate: X509Certificate,
  ) {
    this.certPem = certPem;
    this.keyPem = keyPem;
    this.keyObject = keyObject;
    this.caPem = caPem;
    this.certificate = certificate;
    this.caCertificate = caCertificate;
  }

  /**
   * Loads and validates the configured TLS material.
   *
   * @param config - Validated runtime configuration.
   * @returns Parsed material ready for Node HTTPS servers.
   * @throws {TlsMaterialError} When a file is unreadable, malformed, mismatched, or not a CA.
   */
  public static load(config: OpenVaultConfig): TlsMaterial {
    const certPem = readPem("OPENVAULT_TLS_CERT", config.tlsCertPath);
    const keyPem = readPem("OPENVAULT_TLS_KEY", config.tlsKeyPath);
    const caPem = readPem("OPENVAULT_INTERNAL_CA", config.internalCaPath);

    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(certPem);
    } catch {
      throw new TlsMaterialError("OPENVAULT_TLS_CERT", "must contain a valid PEM certificate");
    }

    let keyObject: KeyObject;
    try {
      keyObject = createPrivateKey(keyPem);
    } catch {
      throw new TlsMaterialError("OPENVAULT_TLS_KEY", "must contain a valid PEM private key");
    }

    if (!certificate.checkPrivateKey(keyObject)) {
      throw new TlsMaterialError(
        "OPENVAULT_TLS_KEY",
        "does not match the configured server certificate",
      );
    }
    assertCurrentlyValid("OPENVAULT_TLS_CERT", certificate);

    let caCertificate: X509Certificate;
    try {
      caCertificate = new X509Certificate(caPem);
    } catch {
      throw new TlsMaterialError("OPENVAULT_INTERNAL_CA", "must contain a valid PEM certificate");
    }

    if (!caCertificate.ca) {
      throw new TlsMaterialError("OPENVAULT_INTERNAL_CA", "must have CA basic constraints");
    }
    if (!caCertificate.verify(caCertificate.publicKey)) {
      throw new TlsMaterialError("OPENVAULT_INTERNAL_CA", "must be self-verifying");
    }
    assertCurrentlyValid("OPENVAULT_INTERNAL_CA", caCertificate);

    return new TlsMaterial(certPem, keyPem, keyObject, caPem, certificate, caCertificate);
  }

  /**
   * Re-checks the parsed material for readiness.
   *
   * @throws {TlsMaterialError} When the key, CA flag, or CA signature no longer validates.
   */
  public checkReady(): void {
    if (!this.certificate.checkPrivateKey(this.keyObject)) {
      throw new TlsMaterialError("OPENVAULT_TLS_KEY", "does not match the server certificate");
    }
    if (!this.caCertificate.ca) {
      throw new TlsMaterialError("OPENVAULT_INTERNAL_CA", "must have CA basic constraints");
    }
    if (!this.caCertificate.verify(this.caCertificate.publicKey)) {
      throw new TlsMaterialError("OPENVAULT_INTERNAL_CA", "must be self-verifying");
    }
    assertCurrentlyValid("OPENVAULT_TLS_CERT", this.certificate);
    assertCurrentlyValid("OPENVAULT_INTERNAL_CA", this.caCertificate);
  }
}
