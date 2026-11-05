import { lstatSync, rmSync } from "node:fs";
import { z } from "zod";
import { CliError } from "../errors.js";
import {
  ensureSecureDirectory,
  readPrivateFile,
  removeFile,
  writeFileAtomic,
} from "./fs-secure.js";
import { withFileLock } from "./lock.js";
import { type CredentialPaths, resolveCredentialPaths } from "./paths.js";

const credentialSchema = z.strictObject({
  version: z.literal(1),
  baseUrl: z.url(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessExpiresAt: z.iso.datetime(),
  refreshExpiresAt: z.iso.datetime(),
});

/** The only persisted credential shape. */
export type CredentialDocument = z.infer<typeof credentialSchema>;

/** Options for {@link CredentialStore}. */
export interface CredentialStoreOptions {
  /** Process environment. */
  readonly env: NodeJS.ProcessEnv;
  /** Node platform. */
  readonly platform?: NodeJS.Platform;
  /** Home directory override. */
  readonly home?: string;
}

/** Validates one credential document. */
export function parseCredentialDocument(value: unknown): CredentialDocument {
  const parsed = credentialSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError("credential_store_corrupt", "The credential file is not valid");
  }
  let url: URL;
  try {
    url = new URL(parsed.data.baseUrl);
  } catch {
    throw new CliError("credential_store_corrupt", "The credential file has an invalid server URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new CliError("credential_store_corrupt", "The credential file has an invalid server URL");
  }
  return parsed.data;
}

/**
 * Owns the CLI credential file.
 *
 * Every read and write validates the directory and file security before using
 * the bytes. Refresh, login, and logout take the same lock.
 */
export class CredentialStore {
  readonly #paths: CredentialPaths;
  readonly #platform: NodeJS.Platform;

  /**
   * @param options - Environment and platform overrides.
   * @throws {CliError} On native Windows, where an owner-only ACL cannot be enforced.
   */
  public constructor(options: CredentialStoreOptions) {
    this.#platform = options.platform ?? process.platform;
    if (this.#platform === "win32") {
      throw new CliError(
        "credential_store_unsupported",
        "Native Windows credential storage is not supported; use WSL",
      );
    }
    this.#paths = resolveCredentialPaths(options.env, this.#platform, options.home);
  }

  /** Directory that holds the credential and lock files. */
  public get directory(): string {
    return this.#paths.directory;
  }

  /** Credential file path. */
  public get file(): string {
    return this.#paths.file;
  }

  /** Lock file path. */
  public get lockFile(): string {
    return this.#paths.lockFile;
  }

  /**
   * Loads and validates the credential file.
   *
   * @returns The document, or undefined when the file does not exist.
   * @throws {CliError} When the directory, file, or JSON is insecure or invalid.
   */
  public load(): CredentialDocument | undefined {
    ensureSecureDirectory(this.#paths.directory);
    const bytes = readPrivateFile(this.#paths.file);
    if (bytes === undefined) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new CliError("credential_store_corrupt", "The credential file is not valid JSON");
    }
    return parseCredentialDocument(parsed);
  }

  /**
   * Writes the complete credential document atomically.
   *
   * @param document - Validated token state.
   */
  public save(document: CredentialDocument): void {
    const validated = parseCredentialDocument(document);
    writeFileAtomic(this.#paths.file, JSON.stringify(validated), 0o600);
  }

  /** Removes the credential file. The caller owns the lock. */
  public remove(): void {
    ensureSecureDirectory(this.#paths.directory);
    removeFile(this.#paths.file);
  }

  /**
   * Removes the credential file even when the directory is no longer secure.
   *
   * This is the logout recovery path: an operator who loosened the directory
   * mode must still be able to delete the token file. Only a regular,
   * non-symlink file is unlinked; missing files are not an error.
   */
  public forceRemove(): void {
    try {
      const stat = lstatSync(this.#paths.file);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        rmSync(this.#paths.file, { force: true });
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
        return;
      }
      throw new CliError(
        "credential_store_unavailable",
        "The credential file could not be removed",
        {
          cause: error,
        },
      );
    }
  }

  /**
   * Runs one read-modify-write critical section under the credential lock.
   *
   * @param action - Locked action.
   * @returns The action result.
   */
  public async withLock<T>(action: () => Promise<T> | T): Promise<T> {
    return await withFileLock(this.#paths.lockFile, action);
  }

  /**
   * Returns the current access token.
   *
   * @throws {CliError} `authentication_required` when no credential exists.
   */
  public accessToken(): string {
    const document = this.load();
    if (document === undefined) {
      throw new CliError("authentication_required", "Run ov login", { exitCode: 3 });
    }
    return document.accessToken;
  }
}
