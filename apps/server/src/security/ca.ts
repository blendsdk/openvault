import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createPrivateKey,
  randomBytes,
} from "node:crypto";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { KeyringProvider } from "./keyring.js";
import {
  type AgentCsr,
  type CaCertificate,
  type IssuedCertificate,
  issueAgentCertificate,
  p256PointFromSpki,
  verifyAgentCertificateProfile,
  x509,
} from "./x509.js";

/** Bytes in a P-256 scalar and in one wrapped scalar. */
const SCALAR_BYTES = 32;
/** Bytes in an AES-GCM nonce. */
const NONCE_BYTES = 12;
/** Bytes in an AES-GCM authentication tag. */
const TAG_BYTES = 16;
/** Compressed/uncompressed P-256 public point length. */
const PUBLIC_POINT_BYTES = 65;
/** Synthetic identity used by the readiness probe. */
const PROBE_PRINCIPAL = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
/** Probe lifetime in days. */
const PROBE_TTL_DAYS = 1;

/** Raised when the internal CA cannot be loaded or used. Contains no key bytes. */
export class CaSignerUnavailableError extends Error {
  public constructor() {
    super("Internal certificate authority is unavailable");
    this.name = "CaSignerUnavailableError";
  }
}

/** One unwrapped CA row used by the signer. */
export interface CaKeyRow {
  /** Row identifier. */
  readonly id: string;
  /** CA certificate PEM. */
  readonly certPem: string;
  /** Uncompressed P-256 public point. */
  readonly publicKey: Buffer;
  /** AES-GCM ciphertext of the scalar. */
  readonly wrappedKey: Buffer;
  /** AES-GCM nonce. */
  readonly wrapNonce: Buffer;
  /** AES-GCM tag. */
  readonly wrapTag: Buffer;
  /** KEK identifier. */
  readonly kekId: string;
  /** Current or retired. */
  readonly status: "current" | "retired";
  /** Creation time. */
  readonly createdAt: Date;
  /** Activation time. */
  readonly activatedAt: Date;
  /** Retirement time. */
  readonly retiredAt: Date | null;
}

/** Wrapped CA scalar material ready for storage. */
export interface WrappedCaKey {
  /** Ciphertext. */
  readonly wrappedKey: Buffer;
  /** Nonce. */
  readonly wrapNonce: Buffer;
  /** Authentication tag. */
  readonly wrapTag: Buffer;
  /** KEK identifier. */
  readonly kekId: string;
}

/** Options for {@link CaSigner.load}. */
export interface CaSignerOptions {
  /** Connected database. */
  readonly database: PostgreSQLDatabase;
  /** Loaded KEK provider. */
  readonly keyring: KeyringProvider;
  /** Internal CA certificate PEM from `OPENVAULT_INTERNAL_CA`. */
  readonly caPem: string;
  /** Injectable clock in milliseconds since the Unix epoch. */
  readonly now?: () => number;
  /** Test-only deterministic serial source. */
  readonly serialSource?: () => string;
}

interface CaRow {
  readonly id: string;
  readonly cert_pem: string;
  readonly public_key: Buffer;
  readonly wrapped_key: Buffer;
  readonly wrap_nonce: Buffer;
  readonly wrap_tag: Buffer;
  readonly kek_id: string;
  readonly status: string;
  readonly created_at: Date;
  readonly activated_at: Date;
  readonly retired_at: Date | null;
}

/** Builds the row-bound additional authenticated data. */
function aadFor(id: string): Buffer {
  return Buffer.from(`ov:ca:v1:${id}`, "utf8");
}

/**
 * Wraps one CA scalar with the current KEK.
 *
 * The AAD binds the ciphertext to the `ca_keys.id`, so rows cannot be swapped.
 * The caller owns the input buffer and must zero it after this call.
 *
 * @param keyring - Loaded keyring.
 * @param id - Target `ca_keys.id`.
 * @param scalar - 32-byte P-256 scalar.
 * @returns Ciphertext, nonce, tag, and KEK identifier.
 * @throws {Error} When the scalar length is wrong or no KEK is loaded.
 */
export function wrapCaScalar(keyring: KeyringProvider, id: string, scalar: Buffer): WrappedCaKey {
  if (scalar.length !== SCALAR_BYTES) {
    throw new Error("CA scalar must be 32 bytes");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const kekId = keyring.currentId;
  if (kekId === undefined) {
    throw new Error("Keyring is not loaded");
  }
  return keyring.withCurrentKey((key) => {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aadFor(id));
    const wrappedKey = Buffer.concat([cipher.update(scalar), cipher.final()]);
    const wrapTag = cipher.getAuthTag();
    return { wrappedKey, wrapNonce: nonce, wrapTag, kekId };
  });
}

/**
 * Unwraps one CA scalar with the KEK recorded on its row.
 *
 * @param keyring - Loaded keyring.
 * @param input - Row id and wrapped material.
 * @returns The 32-byte scalar.
 * @throws {Error} When the KEK is missing, the tag fails, or the length is wrong.
 */
export function unwrapCaScalar(
  keyring: KeyringProvider,
  input: {
    readonly id: string;
    readonly wrappedKey: Buffer;
    readonly wrapNonce: Buffer;
    readonly wrapTag: Buffer;
    readonly kekId: string;
  },
): Buffer {
  if (
    input.wrappedKey.length !== SCALAR_BYTES ||
    input.wrapNonce.length !== NONCE_BYTES ||
    input.wrapTag.length !== TAG_BYTES
  ) {
    throw new Error("Wrapped CA scalar has invalid lengths");
  }
  return keyring.withKey(input.kekId, (key) => {
    const decipher = createDecipheriv("aes-256-gcm", key, input.wrapNonce);
    decipher.setAAD(aadFor(input.id));
    decipher.setAuthTag(input.wrapTag);
    let updated: Buffer | undefined;
    let finalized: Buffer | undefined;
    try {
      updated = decipher.update(input.wrappedKey);
      finalized = decipher.final();
      const scalar = Buffer.concat([updated, finalized]);
      if (scalar.length !== SCALAR_BYTES) {
        scalar.fill(0);
        throw new Error("Unwrapped CA scalar has invalid length");
      }
      return scalar;
    } finally {
      updated?.fill(0);
      finalized?.fill(0);
    }
  });
}

/**
 * Derives the uncompressed public point from a P-256 scalar.
 *
 * @param scalar - 32-byte scalar.
 * @returns `0x04 || x || y`.
 */
export function publicPointFromScalar(scalar: Buffer): Buffer {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(scalar);
  return ecdh.getPublicKey();
}

/** Compares two buffers without leaking the first difference through timing. */
function buffersEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/**
 * Loads and owns the current internal CA signing key.
 *
 * The class is the only holder of the CA private key. Public methods expose
 * certificate issuance and a probe, never the scalar or the signing key.
 */
export class CaSigner {
  #caCertificate: CaCertificate | undefined;
  #signingKey: CryptoKey | undefined;
  readonly #caPem: string;
  readonly #now: () => number;
  readonly #serialSource: (() => string) | undefined;
  #destroyed = false;

  private constructor(options: {
    caCertificate: CaCertificate;
    signingKey: CryptoKey;
    caPem: string;
    now: () => number;
    serialSource?: () => string;
  }) {
    this.#caCertificate = options.caCertificate;
    this.#signingKey = options.signingKey;
    this.#caPem = options.caPem;
    this.#now = options.now;
    this.#serialSource = options.serialSource;
  }

  /**
   * Issues one server certificate with the loaded CA key.
   *
   * The CA key stays inside this signer; init never receives the scalar. The
   * generated leaf is a normal TLS server certificate for the supplied DNS and
   * IP names.
   *
   * @param options - Subject, DNS/IP SANs, and validity window.
   * @returns The leaf certificate PEM and its PKCS#8 private key PEM.
   */
  public async issueServerCertificate(options: {
    readonly subject: string;
    readonly dnsNames: readonly string[];
    readonly ipAddresses: readonly string[];
    readonly notBefore?: Date;
    readonly notAfter?: Date;
  }): Promise<{ readonly certificatePem: string; readonly privateKeyPem: string }> {
    if (this.#destroyed || this.#signingKey === undefined || this.#caCertificate === undefined) {
      throw new CaSignerUnavailableError();
    }
    const keys = (await globalThis.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const sans = [
      ...options.dnsNames.map((value) => ({ type: "dns" as const, value })),
      ...options.ipAddresses.map((value) => ({ type: "ip" as const, value })),
    ];
    const certificate = await x509.X509CertificateGenerator.create({
      serialNumber: randomBytes(8).toString("hex"),
      subject: options.subject,
      issuer: this.#caCertificate.subject,
      notBefore: options.notBefore ?? new Date(this.#now() - 60_000),
      notAfter: options.notAfter ?? new Date(this.#now() + 365 * 86_400_000),
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      publicKey: keys.publicKey,
      signingKey: this.#signingKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
          true,
        ),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
        new x509.SubjectAlternativeNameExtension(sans),
      ],
    });
    const der = await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey);
    const keyObject = createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" });
    const exported = keyObject.export({ format: "pem", type: "pkcs8" });
    return {
      certificatePem: certificate.toString("pem"),
      privateKeyPem: typeof exported === "string" ? exported : exported.toString("utf8"),
    };
  }

  /** CA certificate PEM used as the chain returned to agents. */
  public get certificatePem(): string {
    return this.#caPem;
  }

  /**
   * Loads the single current CA row and validates every matching invariant.
   *
   * @param options - Database, keyring, CA PEM, and clock/serial seams.
   * @returns A ready signer.
   * @throws {CaSignerUnavailableError} On any missing, mismatched, or unwrap failure.
   */
  public static async load(options: CaSignerOptions): Promise<CaSigner> {
    try {
      return await CaSigner.#load(options);
    } catch (error) {
      if (error instanceof CaSignerUnavailableError) {
        throw error;
      }
      throw new CaSignerUnavailableError();
    }
  }

  static async #load(options: CaSignerOptions): Promise<CaSigner> {
    const result = await options.database.executeQuery<CaRow>(
      `SELECT id, cert_pem, public_key, wrapped_key, wrap_nonce, wrap_tag, kek_id,
              status, created_at, activated_at, retired_at
         FROM ca_keys
        WHERE status = 'current'
        LIMIT 1`,
    );
    const row = result.records[0];
    if (row === undefined || row.status !== "current") {
      throw new CaSignerUnavailableError();
    }
    if (
      !Buffer.isBuffer(row.public_key) ||
      row.public_key.length !== PUBLIC_POINT_BYTES ||
      !Buffer.isBuffer(row.wrapped_key) ||
      row.wrapped_key.length !== SCALAR_BYTES ||
      !Buffer.isBuffer(row.wrap_nonce) ||
      row.wrap_nonce.length !== NONCE_BYTES ||
      !Buffer.isBuffer(row.wrap_tag) ||
      row.wrap_tag.length !== TAG_BYTES ||
      row.kek_id.length === 0
    ) {
      throw new CaSignerUnavailableError();
    }

    let caCertificate: CaCertificate;
    let configuredCertificate: CaCertificate;
    try {
      caCertificate = new x509.X509Certificate(row.cert_pem);
      configuredCertificate = new x509.X509Certificate(options.caPem);
    } catch {
      throw new CaSignerUnavailableError();
    }

    if (
      !buffersEqual(Buffer.from(caCertificate.rawData), Buffer.from(configuredCertificate.rawData))
    ) {
      throw new CaSignerUnavailableError();
    }

    const now = (options.now ?? Date.now)();
    if (caCertificate.notBefore.getTime() > now || caCertificate.notAfter.getTime() < now) {
      throw new CaSignerUnavailableError();
    }

    const basicConstraints = caCertificate.getExtension(x509.BasicConstraintsExtension);
    if (basicConstraints === null || !basicConstraints.ca || basicConstraints.pathLength !== 0) {
      throw new CaSignerUnavailableError();
    }
    const keyUsages = caCertificate.getExtension(x509.KeyUsagesExtension);
    if (keyUsages === null || (keyUsages.usages & x509.KeyUsageFlags.keyCertSign) === 0) {
      throw new CaSignerUnavailableError();
    }
    if (
      !(await caCertificate.verify({ publicKey: caCertificate.publicKey, signatureOnly: true }))
    ) {
      throw new CaSignerUnavailableError();
    }

    const certificatePoint = p256PointFromSpki(Buffer.from(caCertificate.publicKey.rawData));
    if (certificatePoint === undefined || !buffersEqual(certificatePoint, row.public_key)) {
      throw new CaSignerUnavailableError();
    }

    const scalar = unwrapCaScalar(options.keyring, {
      id: row.id,
      wrappedKey: row.wrapped_key,
      wrapNonce: row.wrap_nonce,
      wrapTag: row.wrap_tag,
      kekId: row.kek_id,
    });
    try {
      const derivedPoint = publicPointFromScalar(scalar);
      if (!buffersEqual(derivedPoint, row.public_key)) {
        throw new CaSignerUnavailableError();
      }

      const x = row.public_key.subarray(1, 33).toString("base64url");
      const y = row.public_key.subarray(33, 65).toString("base64url");
      const d = scalar.toString("base64url");
      const signingKey = await globalThis.crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x, y, d },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );

      return new CaSigner({
        caCertificate,
        signingKey,
        caPem: configuredCertificate.toString("pem"),
        now: options.now ?? Date.now,
        ...(options.serialSource === undefined ? {} : { serialSource: options.serialSource }),
      });
    } finally {
      scalar.fill(0);
    }
  }

  /**
   * Issues one fixed-profile client certificate.
   *
   * @param csr - Verified CSR.
   * @param principalId - Service principal identifier.
   * @param ttlDays - Total configured lifetime.
   * @returns Issued certificate material.
   * @throws {CaSignerUnavailableError} After destruction.
   */
  public async issueClientCertificate(
    csr: AgentCsr,
    principalId: string,
    ttlDays: number,
  ): Promise<IssuedCertificate> {
    const caCertificate = this.#caCertificate;
    const signingKey = this.#signingKey;
    if (this.#destroyed || caCertificate === undefined || signingKey === undefined) {
      throw new CaSignerUnavailableError();
    }
    try {
      const issued = await issueAgentCertificate({
        publicKey: csr.publicKey,
        principalId,
        caCertificate,
        signingKey,
        ttlDays,
        now: this.#now(),
        ...(this.#serialSource === undefined ? {} : { serialSource: this.#serialSource }),
      });
      if (this.#destroyed) {
        throw new CaSignerUnavailableError();
      }
      return issued;
    } catch {
      throw new CaSignerUnavailableError();
    }
  }

  /**
   * Signs and verifies one ephemeral certificate to prove the key works.
   *
   * @throws {CaSignerUnavailableError} When signing or profile verification fails.
   */
  public async probe(): Promise<void> {
    const caCertificate = this.#caCertificate;
    const signingKey = this.#signingKey;
    if (this.#destroyed || caCertificate === undefined || signingKey === undefined) {
      throw new CaSignerUnavailableError();
    }
    try {
      const keys = await globalThis.crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      );
      const publicKey = await x509.PublicKey.create(keys.publicKey);
      const issued = await issueAgentCertificate({
        publicKey,
        principalId: PROBE_PRINCIPAL,
        caCertificate,
        signingKey,
        ttlDays: PROBE_TTL_DAYS,
        now: this.#now(),
      });
      await verifyAgentCertificateProfile(issued.certificatePem, caCertificate, PROBE_PRINCIPAL);
      if (issued.fingerprint.length !== 64 || this.#destroyed) {
        throw new Error("probe output is invalid");
      }
    } catch {
      throw new CaSignerUnavailableError();
    }
  }

  /** Drops references to the signing key and CA certificate. */
  public destroy(): void {
    this.#destroyed = true;
    this.#signingKey = undefined;
    this.#caCertificate = undefined;
  }
}
