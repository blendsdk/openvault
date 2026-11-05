import { createPrivateKey, type KeyObject, X509Certificate } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AgentError } from "./errors.js";
import { atomicWriteFile, currentUid, ensureSecureDirectory, readRegularFile } from "./fs-utils.js";

/** Persisted identity material. */
export interface StoredIdentity {
  /** Schema version. */
  readonly version: 1;
  /** Service principal identifier. */
  readonly identityId: string;
  /** Leaf certificate PEM. */
  readonly certificatePem: string;
  /** PKCS#8 private key PEM. */
  readonly privateKeyPem: string;
  /** Certificate serial. */
  readonly serial: string;
  /** Certificate expiry. */
  readonly notAfter: string;
  /** First successful join time. */
  readonly joinedAt: string;
}

/** File targets delivered from the previous manifest. */
export interface ManagedFiles {
  /** Schema version. */
  readonly version: 1;
  /** Output root the ledger belongs to. */
  readonly outputDir: string;
  /** Manifest hash at the time of the ledger write. */
  readonly manifestHash: string;
  /** Exact file target names. */
  readonly files: readonly string[];
}

/** In-flight renewal material reused inside the replay window. */
export interface PendingRenewal {
  /** Schema version. */
  readonly version: 1;
  /** PKCS#8 private key PEM. */
  readonly privateKeyPem: string;
  /** CSR PEM. */
  readonly csrPem: string;
  /** Creation time. */
  readonly createdAt: string;
}

const IDENTITY_FILE = "identity.json";
const MANAGED_FILE = "managed-files.json";
const PENDING_FILE = "pending-renewal.json";
const PENDING_TTL_MS = 5 * 60_000;
const FILE_MODE = 0o600;
const FILE_NAME = /^[A-Za-z0-9._-]+$/;

const identitySchema = z.strictObject({
  version: z.literal(1),
  identityId: z.string().min(1).max(26),
  certificatePem: z.string().min(1),
  privateKeyPem: z.string().min(1),
  serial: z.string().min(1).max(128),
  notAfter: z.iso.datetime(),
  joinedAt: z.iso.datetime(),
});
const managedSchema = z.strictObject({
  version: z.literal(1),
  outputDir: z.string().min(1),
  manifestHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  files: z.array(z.string()).max(100),
});
const pendingSchema = z.strictObject({
  version: z.literal(1),
  privateKeyPem: z.string().min(1),
  csrPem: z.string().min(1),
  createdAt: z.iso.datetime(),
});

/** Returns true when a certificate window currently admits use. */
export function certificateWindow(
  certificatePem: string,
): { readonly notBefore: Date; readonly notAfter: Date } | undefined {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    return undefined;
  }
  const notBefore = new Date(certificate.validFrom);
  const notAfter = new Date(certificate.validTo);
  if (!Number.isFinite(notBefore.getTime()) || !Number.isFinite(notAfter.getTime())) {
    return undefined;
  }
  return { notBefore, notAfter };
}

/** Builds the private key object from stored PEM. */
function privateKeyFromPem(pem: string): KeyObject | undefined {
  try {
    return createPrivateKey(pem);
  } catch {
    return undefined;
  }
}

/** Returns true when the stored certificate and key match and are live. */
function usableIdentity(identity: StoredIdentity, now: number): boolean {
  const window = certificateWindow(identity.certificatePem);
  if (
    window === undefined ||
    window.notBefore.getTime() > now ||
    window.notAfter.getTime() <= now
  ) {
    return false;
  }
  const key = privateKeyFromPem(identity.privateKeyPem);
  if (key === undefined) {
    return false;
  }
  try {
    const certificate = new X509Certificate(identity.certificatePem);
    return certificate.checkPrivateKey(key);
  } catch {
    return false;
  }
}

/**
 * Reads one private state file with descriptor-level checks.
 *
 * The file must be opened with `O_NOFOLLOW`, be a regular file, be owned by the
 * current uid where available, and have exact mode `0600`.
 */
function readPrivateFile(path: string): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      return undefined;
    }
    throw new AgentError("agent_state_insecure", "State file could not be opened", {
      cause: error,
    });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new AgentError("agent_state_insecure", "State path must be a regular file");
    }
    const uid = currentUid();
    if (uid !== undefined && stat.uid !== uid) {
      throw new AgentError("agent_state_insecure", "State file must be owned by the current user");
    }
    if ((stat.mode & 0o777) !== FILE_MODE) {
      throw new AgentError("agent_state_insecure", "State file mode must be 0600");
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Parses JSON and maps a parse failure to the state error. */
function parseJson(bytes: Buffer, name: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new AgentError("agent_state_insecure", `${name} is not valid JSON`);
  }
}

/**
 * Owns the agent state directory and its atomic writes.
 *
 * All writes are serialized by the caller (the runner) and use one temporary
 * file plus rename, so a crash cannot leave a half-written identity or ledger.
 */
export class AgentStateStore {
  readonly #directory: string;
  readonly #now: () => number;

  /**
   * @param directory - Absolute state directory.
   * @param options - Injectable clock.
   */
  public constructor(directory: string, options: { readonly now?: () => number } = {}) {
    this.#directory = directory;
    this.#now = options.now ?? Date.now;
  }

  /** Creates and validates the `0700` directory. */
  public prepare(): void {
    ensureSecureDirectory(this.#directory);
  }

  /** Returns the state directory. */
  public get directory(): string {
    return this.#directory;
  }

  /**
   * Loads a usable identity.
   *
   * @returns The identity, or undefined when no state exists or the certificate
   * is expired/not yet valid. A corrupt or insecure file throws.
   */
  public loadIdentity(): StoredIdentity | undefined {
    this.prepare();
    const bytes = readPrivateFile(join(this.#directory, IDENTITY_FILE));
    if (bytes === undefined) {
      return undefined;
    }
    const parsed = identitySchema.safeParse(parseJson(bytes, IDENTITY_FILE));
    if (!parsed.success) {
      throw new AgentError("agent_state_insecure", "identity.json does not match the schema");
    }
    return usableIdentity(parsed.data, this.#now()) ? parsed.data : undefined;
  }

  /** Persists one identity atomically. */
  public saveIdentity(identity: StoredIdentity): void {
    this.prepare();
    atomicWriteFile(join(this.#directory, IDENTITY_FILE), JSON.stringify(identity), FILE_MODE);
  }

  /**
   * Loads the previous managed-file ledger.
   *
   * @param outputDir - Current output root.
   * @returns The ledger, or undefined when absent or scoped to another root.
   */
  public loadManagedFiles(outputDir: string): ManagedFiles | undefined {
    this.prepare();
    const bytes = readPrivateFile(join(this.#directory, MANAGED_FILE));
    if (bytes === undefined) {
      return undefined;
    }
    const parsed = managedSchema.safeParse(parseJson(bytes, MANAGED_FILE));
    if (!parsed.success) {
      throw new AgentError("agent_state_insecure", "managed-files.json does not match the schema");
    }
    if (parsed.data.outputDir !== outputDir) {
      return undefined;
    }
    const files = parsed.data.files;
    if (
      files.length > 100 ||
      files.some(
        (name) =>
          !FILE_NAME.test(name) ||
          name === "." ||
          name === ".." ||
          name.includes("/") ||
          name.includes("\\"),
      )
    ) {
      throw new AgentError("agent_state_insecure", "managed-files.json contains an unsafe name");
    }
    return parsed.data;
  }

  /** Persists the managed-file ledger atomically. */
  public saveManagedFiles(ledger: ManagedFiles): void {
    this.prepare();
    atomicWriteFile(join(this.#directory, MANAGED_FILE), JSON.stringify(ledger), FILE_MODE);
  }

  /**
   * Loads a pending renewal younger than five minutes.
   *
   * @returns The pending material, or undefined when absent or stale.
   */
  public loadPendingRenewal(): PendingRenewal | undefined {
    this.prepare();
    const bytes = readPrivateFile(join(this.#directory, PENDING_FILE));
    if (bytes === undefined) {
      return undefined;
    }
    const parsed = pendingSchema.safeParse(parseJson(bytes, PENDING_FILE));
    if (!parsed.success) {
      throw new AgentError(
        "agent_state_insecure",
        "pending-renewal.json does not match the schema",
      );
    }
    const created = Date.parse(parsed.data.createdAt);
    if (!Number.isFinite(created) || this.#now() - created >= PENDING_TTL_MS) {
      return undefined;
    }
    return parsed.data;
  }

  /** Persists pending renewal material atomically. */
  public savePendingRenewal(pending: PendingRenewal): void {
    this.prepare();
    atomicWriteFile(join(this.#directory, PENDING_FILE), JSON.stringify(pending), FILE_MODE);
  }

  /** Deletes the pending renewal file if present. */
  public deletePendingRenewal(): void {
    try {
      rmSync(join(this.#directory, PENDING_FILE), { force: true });
    } catch {
      throw new AgentError("agent_state_write_failed", "Pending renewal could not be removed");
    }
  }
}
