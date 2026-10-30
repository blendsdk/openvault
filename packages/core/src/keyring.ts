import { randomBytes } from "node:crypto";
import { inspect } from "node:util";

/** Raised when a keyring is malformed, a key is missing, or a keyring was destroyed. */
export class KeyringError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "KeyringError";
  }
}

/** Serialized status returned by {@link Keyring.toJSON}. It contains no key material. */
export interface KeyringStatus {
  /** On-disk format version. */
  readonly version: 1;
  /** Current key identifier. */
  readonly current: string;
  /** Every available key identifier. */
  readonly keyIds: readonly string[];
}

const KEY_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function assertKeyId(id: string): void {
  if (!KEY_ID_PATTERN.test(id) || RESERVED_IDS.has(id)) {
    throw new KeyringError(`Key identifier ${id} is invalid`);
  }
}

function assertKeyBuffer(key: unknown, id: string): asserts key is Buffer {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new KeyringError(`Key ${id} must be a 32-byte Buffer`);
  }
}

/**
 * Holds the current key encryption key (KEK) and older keys still needed to
 * decrypt existing data.
 *
 * Key bytes are only available inside a synchronous callback. The class never
 * returns a raw buffer, serializes key bytes, or prints its internal map.
 * Destruction is best-effort zeroization: Node cannot wipe copies that the
 * runtime or a caller already made.
 */
export class Keyring {
  readonly #keys: Map<string, Buffer>;
  readonly #currentId: string;
  #destroyed = false;

  public constructor(keys: Readonly<Record<string, Buffer>>, currentId: string) {
    assertKeyId(currentId);
    const entries = Object.entries(keys);
    if (entries.length === 0) {
      throw new KeyringError("Keyring must contain at least one key");
    }

    const copy = new Map<string, Buffer>();
    for (const [id, key] of entries) {
      assertKeyId(id);
      assertKeyBuffer(key, id);
      copy.set(id, Buffer.from(key));
    }

    if (!copy.has(currentId)) {
      throw new KeyringError(`Current key ${currentId} is not present in the keyring`);
    }

    this.#keys = copy;
    this.#currentId = currentId;
  }

  /** Identifier of the key new data must be encrypted with. */
  public get currentId(): string {
    return this.#currentId;
  }

  /** Reports whether {@link destroy} has run. No key material is exposed. */
  public get destroyed(): boolean {
    return this.#destroyed;
  }

  /** Reports whether a key identifier is available and the keyring is alive. */
  public has(id: string): boolean {
    return !this.#destroyed && this.#keys.has(id);
  }

  /**
   * Runs a synchronous action with the current key.
   *
   * The callback must not retain or mutate the buffer. The keyring throws after
   * {@link destroy} or when the current key is unavailable.
   */
  public withCurrentKey<T>(action: (key: Readonly<Buffer>) => T): T {
    return this.withKey(this.#currentId, action);
  }

  /**
   * Runs a synchronous action with a named key.
   *
   * The callback must not retain or mutate the buffer.
   */
  public withKey<T>(id: string, action: (key: Readonly<Buffer>) => T): T {
    if (this.#destroyed) {
      throw new KeyringError("Keyring has been destroyed");
    }
    assertKeyId(id);
    const key = this.#keys.get(id);
    if (!key) {
      throw new KeyringError(`Key ${id} is not present in the keyring`);
    }
    return action(key);
  }

  /**
   * Zeroes every key buffer and clears the keyring.
   *
   * The operation is idempotent. Zeroization is best-effort because JavaScript
   * cannot guarantee that no runtime copy exists.
   */
  public destroy(): void {
    if (this.#destroyed) {
      return;
    }
    for (const key of this.#keys.values()) {
      key.fill(0);
    }
    this.#keys.clear();
    this.#destroyed = true;
  }

  /** Returns status only; key bytes are never serialized. */
  public toJSON(): KeyringStatus {
    return {
      version: 1,
      current: this.#currentId,
      keyIds: [...this.#keys.keys()],
    };
  }

  /** Prints status only; key bytes and the internal map are never inspected. */
  public [inspect.custom](): string {
    return `Keyring(current=${this.#currentId}, keys=${this.#keys.size}, redacted)`;
  }

  /**
   * Parses and validates the on-disk keyring shape.
   *
   * The accepted shape is `{ version: 1, current, keys: { [id]: base64 } }`.
   * Each key must decode to exactly 32 bytes from canonical base64.
   */
  public static fromJSON(value: unknown): Keyring {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new KeyringError("Keyring must be a JSON object");
    }

    const record = value as Record<string, unknown>;
    if (record.version !== 1) {
      throw new KeyringError("Unsupported keyring version");
    }
    if (typeof record.current !== "string" || record.current.length === 0) {
      throw new KeyringError("Keyring current key is missing");
    }
    if (typeof record.keys !== "object" || record.keys === null || Array.isArray(record.keys)) {
      throw new KeyringError("Keyring keys are missing");
    }

    const decoded: Record<string, Buffer> = {};
    const entries = Object.entries(record.keys as Record<string, unknown>);
    if (entries.length === 0) {
      throw new KeyringError("Keyring must contain at least one key");
    }

    try {
      for (const [id, encoded] of entries) {
        assertKeyId(id);
        if (typeof encoded !== "string" || !BASE64_PATTERN.test(encoded) || encoded.length === 0) {
          throw new KeyringError(`Key ${id} must be a canonical base64 string`);
        }
        const key = Buffer.from(encoded, "base64");
        if (key.length !== KEY_BYTES) {
          key.fill(0);
          throw new KeyringError(`Key ${id} must decode to 32 bytes`);
        }
        if (key.toString("base64") !== encoded) {
          key.fill(0);
          throw new KeyringError(`Key ${id} must be a canonical base64 string`);
        }
        decoded[id] = key;
      }

      return new Keyring(decoded, record.current);
    } finally {
      for (const key of Object.values(decoded)) {
        key.fill(0);
      }
    }
  }

  /** Creates a fresh keyring with one 32-byte key. */
  public static generate(id = "k1"): Keyring {
    return new Keyring({ [id]: randomBytes(KEY_BYTES) }, id);
  }
}
