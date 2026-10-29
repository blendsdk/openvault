import { randomBytes } from "node:crypto";

/** A key encryption key (KEK) and the identifier stored alongside wrapped data. */
export interface KeyMaterial {
  /** Stable key identifier written into every wrapped record. */
  readonly id: string;
  /** 32-byte AES-256 key. The caller must not mutate or log this buffer. */
  readonly key: Buffer;
}

/** Raised when a keyring is malformed or a key is missing. */
export class KeyringError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "KeyringError";
  }
}

const KEY_BYTES = 32;

/**
 * Holds the current KEK and any older keys still needed to decrypt existing data.
 *
 * The keyring is deliberately small and dependency-free. It is loaded from a file by the
 * server and is never stored in PostgreSQL.
 */
export class Keyring {
  private readonly keys: Map<string, Buffer>;
  private readonly currentId: string;

  public constructor(keys: Readonly<Record<string, Buffer>>, currentId: string) {
    const entries = Object.entries(keys);
    if (entries.length === 0) {
      throw new KeyringError("Keyring must contain at least one key");
    }

    const copy = new Map<string, Buffer>();
    for (const [id, key] of entries) {
      if (id.length === 0) {
        throw new KeyringError("Key identifier must not be empty");
      }
      if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
        throw new KeyringError(`Key ${id} must be a 32-byte Buffer`);
      }
      copy.set(id, Buffer.from(key));
    }

    if (!copy.has(currentId)) {
      throw new KeyringError(`Current key ${currentId} is not present in the keyring`);
    }

    this.keys = copy;
    this.currentId = currentId;
  }

  /** Returns the key new data must be encrypted with. */
  public get current(): KeyMaterial {
    return this.get(this.currentId);
  }

  /** Returns a key by identifier. */
  public get(id: string): KeyMaterial {
    const key = this.keys.get(id);
    if (!key) {
      throw new KeyringError(`Key ${id} is not present in the keyring`);
    }
    return { id, key };
  }

  /** Reports whether a key identifier is available. */
  public has(id: string): boolean {
    return this.keys.has(id);
  }

  /** Serializes the keyring to the on-disk JSON shape. */
  public toJSON(): { version: 1; current: string; keys: Record<string, string> } {
    const keys: Record<string, string> = {};
    for (const [id, key] of this.keys) {
      keys[id] = key.toString("base64");
    }
    return { version: 1, current: this.currentId, keys };
  }

  /** Parses and validates the on-disk keyring shape. */
  public static fromJSON(value: unknown): Keyring {
    if (typeof value !== "object" || value === null) {
      throw new KeyringError("Keyring must be a JSON object");
    }

    const record = value as Record<string, unknown>;
    if (record.version !== 1) {
      throw new KeyringError("Unsupported keyring version");
    }
    if (typeof record.current !== "string" || record.current.length === 0) {
      throw new KeyringError("Keyring current key is missing");
    }
    if (typeof record.keys !== "object" || record.keys === null) {
      throw new KeyringError("Keyring keys are missing");
    }

    const decoded: Record<string, Buffer> = {};
    for (const [id, encoded] of Object.entries(record.keys as Record<string, unknown>)) {
      if (typeof encoded !== "string") {
        throw new KeyringError(`Key ${id} must be a base64 string`);
      }
      const key = Buffer.from(encoded, "base64");
      if (key.length !== KEY_BYTES) {
        throw new KeyringError(`Key ${id} must decode to 32 bytes`);
      }
      decoded[id] = key;
    }

    return new Keyring(decoded, record.current);
  }

  /** Creates a fresh keyring with one 32-byte key. */
  public static generate(id = "k1"): Keyring {
    return new Keyring({ [id]: randomBytes(KEY_BYTES) }, id);
  }
}
