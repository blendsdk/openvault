import { createHash } from "node:crypto";
import { Decrypter, Encrypter } from "age-encryption";
import { z } from "zod";
import { OpsError } from "./errors.js";

/** Archive format marker. */
export const BACKUP_FORMAT = "openvault-backup";
/** Archive format version. */
export const BACKUP_VERSION = 1;
/** Server release recorded in the manifest. */
export const SERVER_VERSION = "0.1.0";

/** The files every archive must contain. */
export const ARCHIVE_FILES = [
  "database.json",
  "keyring.json",
  "config.json",
  "ca.pem",
  "checkpoints.ndjson",
] as const;

/** One required archive filename. */
export type ArchiveFileName = (typeof ARCHIVE_FILES)[number];

const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.strictObject({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_VERSION),
  createdAt: z.iso.datetime(),
  serverVersion: z.string().min(1).max(64),
  checksums: z.record(z.string(), checksumSchema),
});
const payloadSchema = z.strictObject({
  manifest: manifestSchema,
  files: z.record(z.string(), z.string()),
});

/** One verified archive payload. */
export interface OpenArchive {
  /** Validated manifest. */
  readonly manifest: z.infer<typeof manifestSchema>;
  /** File contents keyed by archive filename. */
  readonly files: Readonly<Record<ArchiveFileName, string>>;
}

/** Input files for one archive. */
export type ArchiveFiles = Readonly<Record<ArchiveFileName, string>>;

/** Computes the lowercase hexadecimal SHA-256 of one string or buffer. */
export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Builds one checksum manifest for the supplied files. */
export function buildChecksums(files: ArchiveFiles): Readonly<Record<string, string>> {
  const checksums: Record<string, string> = {};
  for (const name of ARCHIVE_FILES) {
    checksums[name] = sha256Hex(files[name]);
  }
  return checksums;
}

/**
 * Creates one passphrase-encrypted age archive.
 *
 * @param files - Required archive files.
 * @param options - Passphrase and creation metadata.
 * @returns The binary age archive.
 */
export async function createArchive(
  files: ArchiveFiles,
  options: {
    readonly passphrase: string;
    readonly now?: Date;
    readonly serverVersion?: string;
  },
): Promise<Buffer> {
  if (options.passphrase.length < 12) {
    throw new OpsError("ops_configuration", "The backup passphrase must be at least 12 characters");
  }
  const manifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: (options.now ?? new Date()).toISOString(),
    serverVersion: options.serverVersion ?? SERVER_VERSION,
    checksums: buildChecksums(files),
  };
  const payload = Buffer.from(JSON.stringify({ manifest, files }), "utf8");
  try {
    const encrypter = new Encrypter();
    encrypter.setPassphrase(options.passphrase);
    return Buffer.from(await encrypter.encrypt(payload));
  } catch (error) {
    throw new OpsError("backup_failed", "The backup archive could not be encrypted", {
      cause: error,
    });
  }
}

/**
 * Decrypts and verifies one archive.
 *
 * Every required file must be present and its checksum must match. A wrong
 * passphrase, malformed payload, or checksum mismatch fails before the caller
 * touches the target database.
 *
 * @param archive - Binary age archive.
 * @param passphrase - Operator passphrase.
 * @returns The verified files and manifest.
 */
export async function openArchive(archive: Buffer, passphrase: string): Promise<OpenArchive> {
  let plaintext: Uint8Array;
  try {
    const decrypter = new Decrypter();
    decrypter.addPassphrase(passphrase);
    plaintext = await decrypter.decrypt(archive);
  } catch (error) {
    throw new OpsError("backup_archive_invalid", "The backup archive could not be decrypted", {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(plaintext).toString("utf8")) as unknown;
  } catch (error) {
    throw new OpsError("backup_archive_invalid", "The backup archive payload is not valid JSON", {
      cause: error,
    });
  }
  const result = payloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new OpsError("backup_archive_invalid", "The backup archive manifest is invalid");
  }
  const files: Partial<Record<ArchiveFileName, string>> = {};
  for (const name of ARCHIVE_FILES) {
    const value = result.data.files[name];
    if (typeof value !== "string") {
      throw new OpsError("backup_archive_invalid", `The backup archive is missing ${name}`);
    }
    files[name] = value;
    const expected = result.data.manifest.checksums[name];
    if (expected === undefined) {
      throw new OpsError("backup_archive_invalid", `The backup manifest is missing ${name}`);
    }
    if (sha256Hex(value) !== expected) {
      throw new OpsError("backup_checksum_mismatch", `The backup file ${name} failed verification`);
    }
  }
  return {
    manifest: result.data.manifest,
    files: files as Record<ArchiveFileName, string>,
  };
}
