import { createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import type { CaSigner } from "../security/ca.js";
import { InitError } from "./errors.js";

/** Options for ensuring the server certificate. */
export interface EnsureTlsOptions {
  /** Loaded CA signer. */
  readonly signer: CaSigner;
  /** CA certificate PEM. */
  readonly caPem: string;
  /** Server certificate path. */
  readonly certPath: string;
  /** Server private key path. */
  readonly keyPath: string;
  /** Base URL used for SANs. */
  readonly baseUrl: string;
  /** Clock. */
  readonly now: () => number;
}

/** Result of ensuring the TLS pair. */
export interface EnsureTlsResult {
  /** True when this run created the pair. */
  readonly created: boolean;
}

/** Writes one file atomically. */
function writeAtomic(path: string, data: Buffer, mode: 0o600 | 0o644): void {
  const directory = dirname(path);
  const temporary = resolve(directory, `.openvault-init-${randomBytes(8).toString("hex")}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeSync(descriptor, data);
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
    }
    rmSync(temporary, { force: true });
    if (error instanceof InitError) {
      throw error;
    }
    throw new InitError("init_tls", "The TLS file could not be written", { cause: error });
  }
}

/** Reads one regular file through an open descriptor. */
function readRegular(path: string, mode: number): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new InitError("init_tls", "The TLS path must be a regular file");
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) {
      throw new InitError("init_tls", "The TLS file must be owned by the current user");
    }
    if ((Number(stat.mode) & 0o777) !== mode) {
      throw new InitError("init_tls", `The TLS file mode must be 0${mode.toString(8)}`);
    }
    if (stat.size === 0 || stat.size > 1_048_576) {
      throw new InitError("init_tls", "The TLS file size is invalid");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.alloc(65_536);
    for (;;) {
      const remaining = 1_048_576 + 1 - total;
      if (remaining <= 0) {
        throw new InitError("init_tls", "The TLS file size is invalid");
      }
      const bytes = readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytes === 0) {
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytes)));
      total += bytes;
    }
    if (total > 1_048_576) {
      throw new InitError("init_tls", "The TLS file size is invalid");
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof InitError) {
      throw error;
    }
    throw new InitError("init_tls", "The TLS file could not be read", { cause: error });
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

/** Returns the required DNS and IP names. */
function serverNames(baseUrl: string): { dnsNames: string[]; ipAddresses: string[] } {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new InitError("init_configuration", "OPENVAULT_BASE_URL is invalid");
  }
  const dnsNames = new Set(["openvaultd", "localhost"]);
  const ipAddresses = new Set(["127.0.0.1"]);
  if (isIP(host) === 0) {
    dnsNames.add(host);
  } else {
    ipAddresses.add(host);
  }
  return { dnsNames: [...dnsNames], ipAddresses: [...ipAddresses] };
}

/** Validates an existing pair. */
function validatePair(
  certPem: string,
  keyPem: string,
  caPem: string,
  names: { dnsNames: string[]; ipAddresses: string[] },
  now: number,
): void {
  const certificate = new X509Certificate(certPem);
  const ca = new X509Certificate(caPem);
  const keyObject = createPrivateKey(keyPem);
  if (!certificate.checkPrivateKey(keyObject)) {
    throw new InitError("init_tls", "The server certificate and private key do not match");
  }
  if (!certificate.checkIssued(ca)) {
    throw new InitError("init_tls", "The server certificate is not signed by the current CA");
  }
  const notBefore = Date.parse(certificate.validFrom);
  const notAfter = Date.parse(certificate.validTo);
  if (
    !Number.isFinite(notBefore) ||
    !Number.isFinite(notAfter) ||
    now < notBefore ||
    now >= notAfter
  ) {
    throw new InitError("init_tls", "The server certificate is not currently valid");
  }
  const sans = certificate.subjectAltName ?? "";
  for (const name of names.dnsNames) {
    if (!sans.includes(`DNS:${name}`)) {
      throw new InitError("init_tls", `The server certificate is missing DNS:${name}`);
    }
  }
  for (const address of names.ipAddresses) {
    if (!sans.includes(`IP Address:${address}`)) {
      throw new InitError("init_tls", `The server certificate is missing IP:${address}`);
    }
  }
}

/**
 * Ensures one CA-signed server certificate and key pair.
 *
 * An existing pair is reused only when it matches, chains to the current CA,
 * covers every required SAN, and is currently valid. An expired leaf is
 * regenerated from the same CA.
 *
 * @param options - Signer, paths, base URL, and clock.
 * @returns Whether a new pair was created.
 */
export async function ensureServerCertificate(options: EnsureTlsOptions): Promise<EnsureTlsResult> {
  const certExists = lstatIfExists(options.certPath);
  const keyExists = lstatIfExists(options.keyPath);
  if ((certExists === undefined) !== (keyExists === undefined)) {
    throw new InitError("init_tls", "Both the server certificate and key must exist or be absent");
  }
  const names = serverNames(options.baseUrl);
  if (certExists !== undefined && keyExists !== undefined) {
    const certPem = readRegular(options.certPath, 0o644).toString("utf8");
    const keyPem = readRegular(options.keyPath, 0o600).toString("utf8");
    try {
      validatePair(certPem, keyPem, options.caPem, names, options.now());
      return { created: false };
    } catch (error) {
      if (!(error instanceof InitError) || !error.message.includes("currently valid")) {
        throw error;
      }
      // Expired leaves are regenerated from the same CA.
    }
  }
  const issued = await options.signer.issueServerCertificate({
    subject: "CN=openvaultd",
    dnsNames: names.dnsNames,
    ipAddresses: names.ipAddresses,
    notBefore: new Date(options.now() - 60_000),
    notAfter: new Date(options.now() + 365 * 86_400_000),
  });
  writeAtomic(options.certPath, Buffer.from(issued.certificatePem, "utf8"), 0o644);
  writeAtomic(options.keyPath, Buffer.from(issued.privateKeyPem, "utf8"), 0o600);
  // Re-read and validate the committed pair so a partial or swapped write is
  // never reported as success.
  validatePair(
    readRegular(options.certPath, 0o644).toString("utf8"),
    readRegular(options.keyPath, 0o600).toString("utf8"),
    options.caPem,
    names,
    options.now(),
  );
  return { created: true };
}

/** Returns `lstat` or undefined. */
function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      return undefined;
    }
    throw new InitError("init_tls", "The TLS path could not be inspected");
  }
}
