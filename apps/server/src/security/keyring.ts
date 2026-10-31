import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { inspect } from "node:util";
import { Keyring, KeyringError } from "@openvault/core";

/** Redacted status returned by {@link KeyringProvider}. It contains no key bytes. */
export interface KeyringProviderStatus {
  /** Whether a live keyring is loaded. */
  readonly loaded: boolean;
  /** Current key identifier, present only while loaded. */
  readonly currentId?: string;
  /** Number of available keys. */
  readonly keyCount: number;
}

/**
 * Loads a keyring file and exposes only status information to the server.
 *
 * The file must be an absolute regular file with exactly `0600` permission
 * bits. Key bytes stay inside the core {@link Keyring}; neither JSON
 * serialization nor `util.inspect` traverses them.
 */
export class KeyringProvider {
  #keyring: Keyring | undefined;
  #currentId: string | undefined;
  #keyCount = 0;

  private constructor(keyring: Keyring, currentId: string, keyCount: number) {
    this.#keyring = keyring;
    this.#currentId = currentId;
    this.#keyCount = keyCount;
  }

  /**
   * Loads and validates a keyring file.
   *
   * @param path - Absolute path to the keyring JSON file.
   * @returns A provider that owns the loaded keyring.
   * @throws {KeyringError} When the path, mode, JSON shape, or key material is invalid.
   */
  public static async load(path: string): Promise<KeyringProvider> {
    if (!isAbsolute(path)) {
      throw new KeyringError("Keyring path must be an absolute path");
    }

    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY);
    } catch {
      throw new KeyringError("Keyring file must be a readable regular file");
    }

    let contents: Buffer;
    try {
      const stats = fstatSync(descriptor);
      if (!stats.isFile()) {
        throw new KeyringError("Keyring path must reference a regular file");
      }
      if ((stats.mode & 0o777) !== 0o600) {
        throw new KeyringError("Keyring file must have mode 0600");
      }
      contents = readFileSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.toString("utf8"));
    } catch {
      throw new KeyringError("Keyring file must contain valid JSON");
    } finally {
      contents.fill(0);
    }

    const keyring = Keyring.fromJSON(parsed);
    try {
      const status = keyring.toJSON();
      return new KeyringProvider(keyring, status.current, status.keyIds.length);
    } catch (error) {
      keyring.destroy();
      throw error;
    }
  }

  /** Returns the redacted status of the loaded keyring. */
  public status(): KeyringProviderStatus {
    if (this.#keyring === undefined || this.#currentId === undefined) {
      return { loaded: false, keyCount: 0 };
    }
    return { loaded: true, currentId: this.#currentId, keyCount: this.#keyCount };
  }

  /** Serializes status only, so `JSON.stringify(provider)` cannot reach key bytes. */
  public toJSON(): KeyringProviderStatus {
    return this.status();
  }

  /** Prints status only, so `util.inspect(provider)` cannot reach key bytes. */
  public [inspect.custom](): string {
    const status = this.status();
    return `KeyringProvider(loaded=${status.loaded}, current=${status.currentId ?? "none"}, keys=${status.keyCount})`;
  }

  /** Zeroes and clears the keyring. The operation is idempotent. */
  public destroy(): void {
    this.#keyring?.destroy();
    this.#keyring = undefined;
    this.#currentId = undefined;
    this.#keyCount = 0;
  }
}
