import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { runMigrations } from "blendsdk/codegen";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { migrationConfigPath } from "../db/config.js";
import { parseDatabaseUrl } from "../db/url.js";
import { CaSigner } from "../security/ca.js";
import { KeyringProvider } from "../security/keyring.js";
import { SigningKeyRepository, SigningKeyService } from "../security/signing-keys.js";
import { adminExists, ensureOrganization, ensureOrganizationAndAdmin } from "./admin.js";
import { ensureCa } from "./ca.js";
import { InitError } from "./errors.js";
import { withInitDatabaseLock, withInitLock } from "./lock.js";
import { ensureServerCertificate } from "./tls.js";

/** Options for {@link runInit}. */
export interface InitOptions {
  /** Application database URL. */
  readonly databaseUrl: string;
  /** Optional migrator database URL; defaults to the application URL. */
  readonly migrationDatabaseUrl?: string;
  /** Absolute keyring path. */
  readonly keyringPath: string;
  /** Absolute public internal CA path. */
  readonly internalCaPath?: string;
  /** Optional directory that receives `ca.pem` for the proxy. */
  readonly caPublicDir?: string;
  /** Absolute server certificate path. */
  readonly tlsCertPath?: string;
  /** Absolute server private key path. */
  readonly tlsKeyPath?: string;
  /** Public base URL used for SANs. */
  readonly baseUrl?: string;
  /** Organization display name. */
  readonly orgName?: string;
  /** Administrator display name. */
  readonly adminName?: string;
  /** Administrator email. */
  readonly adminEmail?: string;
  /** Operator-supplied password file. */
  readonly passwordFile?: string;
  /** Generate a one-time password. */
  readonly generatePassword?: boolean;
  /** One-time generated password output path. */
  readonly bootstrapPasswordFile?: string;
  /** Replace an existing public CA file with different bytes. */
  readonly replaceCaPublic?: boolean;
  /** Clock. */
  readonly now?: () => number;
}

/** Result of one bootstrap run. */
export interface InitResult {
  /** True when this run created the keyring. */
  readonly keyringCreated: boolean;
  /** True when this run created the CA. */
  readonly caCreated: boolean;
  /** True when this run created the server certificate/key pair. */
  readonly serverCertificateCreated: boolean;
  /** True when this run created the administrator. */
  readonly adminCreated: boolean;
  /** True when this run created the organization row. */
  readonly orgCreated: boolean;
  /** True when this run created the first signing key. */
  readonly signingKeyCreated: boolean;
  /** One-time password file path, when generated. */
  readonly bootstrapPasswordFile?: string;
  /** Public internal CA path. */
  readonly internalCaPath: string;
  /** Warnings that do not fail the run. */
  readonly warnings: readonly string[];
}

const DEFAULT_BASE_URL = "https://localhost";
const DEFAULT_ORG = "OpenVault";
const DEFAULT_ADMIN_NAME = "OpenVault Administrator";
const DEFAULT_ADMIN_EMAIL = "admin@openvault.local";

/** Returns `lstat` or undefined. */
function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      return undefined;
    }
    throw new InitError("init_insecure", "The bootstrap path could not be inspected");
  }
}

/** Ensures one private directory (keyring/password). */
function ensurePrivateDirectory(path: string): void {
  const existing = lstatIfExists(path);
  if (existing === undefined) {
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } catch {
      throw new InitError("init_insecure", "The bootstrap directory could not be created");
    }
    return;
  }
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw new InitError("init_insecure", "The bootstrap directory must be a real directory");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && existing.uid !== uid) {
    throw new InitError(
      "init_insecure",
      "The bootstrap directory must be owned by the current user",
    );
  }
  // Never tighten a caller-supplied directory. A 0755 volume root is safe
  // because the keyring and password files inside it are 0600; group or
  // world write access is not.
  if ((Number(existing.mode) & 0o022) !== 0) {
    throw new InitError(
      "init_insecure",
      "The bootstrap directory must not be group- or world-writable",
    );
  }
}

/** Ensures one writable directory without tightening its mode. */
function ensureWritableDirectory(path: string): void {
  const existing = lstatIfExists(path);
  if (existing === undefined) {
    try {
      mkdirSync(path, { recursive: true, mode: 0o755 });
    } catch {
      throw new InitError("init_insecure", "The bootstrap directory could not be created");
    }
    return;
  }
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw new InitError("init_insecure", "The bootstrap directory must be a real directory");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && existing.uid !== uid) {
    throw new InitError(
      "init_insecure",
      "The bootstrap directory must be owned by the current user",
    );
  }
}

/** Writes one file atomically with an exact mode. */
function writeAtomic(path: string, data: Buffer | string, mode: 0o600 | 0o644): void {
  const directory = dirname(path);
  ensureWritableDirectory(directory);
  const temporary = resolve(directory, `.openvault-init-${randomBytes(8).toString("hex")}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, data);
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
    throw new InitError("init_insecure", "The bootstrap file could not be written", {
      cause: error,
    });
  }
}

/** Writes the public CA PEM, refusing to replace different bytes silently. */
function writePublicCa(path: string, certPem: string, replace: boolean): void {
  const existing = lstatIfExists(path);
  if (existing !== undefined) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new InitError("init_insecure", "The public CA path must be a regular file");
    }
    if (!replace) {
      const current = readRegularFile(path, {
        mode: 0o644,
        maxBytes: 1_048_576,
        code: "init_insecure",
        label: "public CA file",
      }).toString("utf8");
      if (current === certPem) {
        return;
      }
      throw new InitError(
        "init_insecure",
        "The public CA file differs from the stored CA; pass --replace-ca-public",
      );
    }
  }
  writeAtomic(path, certPem, 0o644);
}

/** Reads at most `maxBytes` from an open descriptor. */
function readBounded(descriptor: number, maxBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  const buffer = Buffer.alloc(65_536);
  for (;;) {
    const remaining = maxBytes + 1 - total;
    if (remaining <= 0) {
      throw new InitError("init_insecure", "The bootstrap file is too large");
    }
    const bytes = readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
    if (bytes === 0) {
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytes)));
    total += bytes;
  }
  if (total > maxBytes) {
    throw new InitError("init_insecure", "The bootstrap file is too large");
  }
  return Buffer.concat(chunks);
}

/** Reads one private regular file through an open descriptor. */
function readRegularFile(
  path: string,
  options: {
    readonly mode: number;
    readonly maxBytes: number;
    readonly code: "init_password" | "init_insecure";
    readonly label: string;
  },
): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new InitError(options.code, `The ${options.label} must be a regular file`);
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) {
      throw new InitError(options.code, `The ${options.label} must be owned by the current user`);
    }
    if ((Number(stat.mode) & 0o777) !== options.mode) {
      throw new InitError(
        options.code,
        `The ${options.label} mode must be 0${options.mode.toString(8)}`,
      );
    }
    if (stat.size === 0 || stat.size > options.maxBytes) {
      throw new InitError(options.code, `The ${options.label} size is invalid`);
    }
    return readBounded(descriptor, options.maxBytes);
  } catch (error) {
    if (error instanceof InitError) {
      throw error;
    }
    throw new InitError(options.code, `The ${options.label} could not be read`, { cause: error });
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

/** Reads one operator password file. */
function readPasswordFile(path: string): string {
  const value = readRegularFile(path, {
    mode: 0o600,
    maxBytes: 4_096,
    code: "init_password",
    label: "password file",
  })
    .toString("utf8")
    .replace(/\r?\n$/, "");
  if (value.length < 12 || value.length > 1024) {
    throw new InitError("init_password", "The bootstrap password must be 12-1024 characters");
  }
  return value;
}

/** Writes the one-time generated password with `O_EXCL`. */
function writeBootstrapPassword(path: string, password: string): void {
  ensurePrivateDirectory(dirname(path));
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeSync(descriptor, Buffer.from(`${password}\n`, "utf8"));
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
    }
    throw new InitError("init_password", "The one-time password file already exists or failed", {
      cause: error,
    });
  }
}

/** Validates the base URL. */
function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InitError("init_configuration", "OPENVAULT_BASE_URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new InitError("init_configuration", "OPENVAULT_BASE_URL must be an HTTPS origin");
  }
  return url.href;
}

/** Requires one absolute path. */
function absolutePath(value: string | undefined, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isAbsolute(value)) {
    throw new InitError("init_configuration", `${name} must be an absolute path`);
  }
  return value;
}

/** Runs migrations under one URL without leaking it. */
async function migrate(databaseUrl: string): Promise<void> {
  const previous = process.env.OPENVAULT_DB_URL;
  process.env.OPENVAULT_DB_URL = databaseUrl;
  try {
    await runMigrations({ command: "up", configPath: migrationConfigPath });
  } finally {
    if (previous === undefined) {
      delete process.env.OPENVAULT_DB_URL;
    } else {
      process.env.OPENVAULT_DB_URL = previous;
    }
  }
}

/** Returns true when any wrapped state exists. */
async function hasWrappedState(database: PostgreSQLDatabase): Promise<boolean> {
  const result = await database.executeQuery<{ present: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM ca_keys)
       OR EXISTS (SELECT 1 FROM signing_keys)
       OR EXISTS (SELECT 1 FROM secret_versions)
       OR EXISTS (SELECT 1 FROM certificate_versions)
       OR EXISTS (SELECT 1 FROM audit_keys)
     ) AS present`,
  );
  return result.records[0]?.present === true;
}

/** Creates or loads the keyring. */
async function ensureKeyring(
  database: PostgreSQLDatabase,
  path: string,
): Promise<{ readonly provider: KeyringProvider; readonly created: boolean }> {
  if (lstatIfExists(path) !== undefined) {
    return { provider: await KeyringProvider.load(path), created: false };
  }
  if (await hasWrappedState(database)) {
    throw new InitError(
      "init_recovery_required",
      "Wrapped state exists but the keyring is missing; restore the keyring from backup",
    );
  }
  const key = randomBytes(32);
  const id = "kek-1";
  const document = JSON.stringify({
    version: 1,
    current: id,
    keys: { [id]: key.toString("base64") },
  });
  const temporary = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  let descriptor: number | undefined;
  let linked = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, document);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // A hard link publishes the fully written file without replacing an
    // existing keyring, so a crash never leaves a partial final file.
    try {
      linkSync(temporary, path);
      linked = true;
    } catch (error) {
      if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "EEXIST") {
        return { provider: await KeyringProvider.load(path), created: false };
      }
      throw error;
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
    }
    if (error instanceof InitError || (error instanceof Error && error.name === "KeyringError")) {
      throw error;
    }
    throw new InitError("init_insecure", "The keyring file could not be created", {
      cause: error,
    });
  } finally {
    rmSync(temporary, { force: true });
    key.fill(0);
  }
  if (!linked) {
    return { provider: await KeyringProvider.load(path), created: false };
  }
  return { provider: await KeyringProvider.load(path), created: true };
}

/**
 * Runs the idempotent bootstrap.
 *
 * @param options - Database URLs, paths, names, and password mode.
 * @returns What was created or reused.
 * @throws {InitError} On configuration, security, recovery, or database failure.
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const now = options.now ?? Date.now;
  try {
    parseDatabaseUrl(options.databaseUrl);
    if (options.migrationDatabaseUrl !== undefined) {
      parseDatabaseUrl(options.migrationDatabaseUrl);
    }
  } catch {
    throw new InitError("init_configuration", "The database URL is invalid");
  }
  const keyringPath = absolutePath(options.keyringPath, "OPENVAULT_KEYRING");
  if (keyringPath === undefined) {
    throw new InitError("init_configuration", "OPENVAULT_KEYRING is required");
  }
  const tlsCertPath = absolutePath(options.tlsCertPath, "OPENVAULT_TLS_CERT");
  const tlsKeyPath = absolutePath(options.tlsKeyPath, "OPENVAULT_TLS_KEY");
  if ((tlsCertPath === undefined) !== (tlsKeyPath === undefined)) {
    throw new InitError("init_configuration", "Both TLS paths must be set or both omitted");
  }
  const baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const internalCaPath =
    absolutePath(options.internalCaPath, "OPENVAULT_INTERNAL_CA") ??
    (tlsCertPath === undefined ? undefined : join(dirname(tlsCertPath), "ca.pem"));
  if (internalCaPath === undefined) {
    throw new InitError(
      "init_configuration",
      "OPENVAULT_INTERNAL_CA or OPENVAULT_TLS_CERT is required",
    );
  }
  const caPublicDir = absolutePath(options.caPublicDir, "OPENVAULT_CA_PUBLIC_DIR");
  const orgName = options.orgName ?? DEFAULT_ORG;
  const adminName = options.adminName ?? DEFAULT_ADMIN_NAME;
  const adminEmail = options.adminEmail ?? DEFAULT_ADMIN_EMAIL;
  if (!adminEmail.includes("@")) {
    throw new InitError("init_configuration", "The administrator email is invalid");
  }
  const passwordFile = absolutePath(options.passwordFile, "OPENVAULT_BOOTSTRAP_PASSWORD_FILE");
  const bootstrapPasswordFile = absolutePath(
    options.bootstrapPasswordFile,
    "OPENVAULT_BOOTSTRAP_PASSWORD_OUTPUT",
  );
  if (options.passwordFile !== undefined && options.generatePassword === true) {
    throw new InitError("init_configuration", "Choose --password-file or --generate-password");
  }

  ensurePrivateDirectory(dirname(keyringPath));
  const lockPath = join(dirname(keyringPath), "init.lock");
  const migrationUrl = options.migrationDatabaseUrl ?? options.databaseUrl;

  // Bootstrap writes create the CA, administrator, signing key, and audit key.
  // Use the owner/migrator connection so the runtime role never needs DDL or
  // writes to key tables.
  const database = new PostgreSQLDatabase({
    ...parseDatabaseUrl(migrationUrl),
    poolConfig: { connectionTimeoutMillis: 2_000 },
    enableGracefulShutdown: false,
  });
  const warnings: string[] = [];
  try {
    return await withInitLock(
      lockPath,
      async () =>
        await withInitDatabaseLock(options.databaseUrl, async () => {
          await migrate(migrationUrl);
          const keyring = await ensureKeyring(database, keyringPath);
          const ca = await ensureCa(database, keyring.provider, now);
          writePublicCa(internalCaPath, ca.certPem, options.replaceCaPublic === true);
          if (caPublicDir !== undefined) {
            writePublicCa(
              join(caPublicDir, "ca.pem"),
              ca.certPem,
              options.replaceCaPublic === true,
            );
          }
          const signer = await CaSigner.load({
            database,
            keyring: keyring.provider,
            caPem: ca.certPem,
            now,
          });
          let serverCertificateCreated = false;
          if (tlsCertPath !== undefined && tlsKeyPath !== undefined) {
            serverCertificateCreated = (
              await ensureServerCertificate({
                signer,
                caPem: ca.certPem,
                certPath: tlsCertPath,
                keyPath: tlsKeyPath,
                baseUrl,
                now,
              })
            ).created;
          } else {
            warnings.push("No TLS paths were supplied; the server certificate was not generated");
          }

          const existingAdmin = await adminExists(database, adminEmail);
          let adminCreated = false;
          let orgCreated = false;
          let generatedPasswordFile: string | undefined;
          if (existingAdmin) {
            orgCreated = await ensureOrganization(database, orgName);
            warnings.push(
              "The bootstrap administrator already exists; its password was not changed",
            );
          } else {
            let password: string;
            if (passwordFile !== undefined) {
              password = readPasswordFile(passwordFile);
            } else if (options.generatePassword === true) {
              password = randomBytes(24).toString("base64url");
              generatedPasswordFile =
                bootstrapPasswordFile ?? join(dirname(keyringPath), "bootstrap-password.txt");
              writeBootstrapPassword(generatedPasswordFile, password);
            } else {
              throw new InitError(
                "init_password",
                "Use --password-file or --generate-password to create the administrator",
              );
            }
            try {
              const admin = await ensureOrganizationAndAdmin({
                database,
                orgName,
                adminName,
                adminEmail,
                password,
                mustChange: false,
              });
              adminCreated = admin.adminCreated;
              orgCreated = admin.orgCreated;
              if (!adminCreated && generatedPasswordFile !== undefined) {
                rmSync(generatedPasswordFile, { force: true });
                generatedPasswordFile = undefined;
                warnings.push(
                  "The bootstrap administrator already exists; the generated password was discarded",
                );
              }
            } catch (error) {
              if (generatedPasswordFile !== undefined) {
                rmSync(generatedPasswordFile, { force: true });
              }
              throw error;
            }
          }

          const signingBefore = await database.executeQuery<{ count: string | number }>(
            "SELECT count(*) AS count FROM signing_keys",
          );
          const signingKeyCreated = Number(signingBefore.records[0]?.count ?? 0) === 0;
          const signing = new SigningKeyService({
            repository: new SigningKeyRepository(database),
            keyring: keyring.provider,
            now,
          });
          try {
            await signing.ensure();
          } finally {
            signing.destroy();
          }

          return {
            keyringCreated: keyring.created,
            caCreated: ca.created,
            serverCertificateCreated,
            adminCreated,
            orgCreated,
            signingKeyCreated,
            ...(generatedPasswordFile === undefined
              ? {}
              : { bootstrapPasswordFile: generatedPasswordFile }),
            internalCaPath,
            warnings,
          };
        }),
    );
  } finally {
    await database.disconnect();
  }
}
