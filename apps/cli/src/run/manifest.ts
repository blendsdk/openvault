import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { projectNameSchema, secretNameSchema } from "@openvault/api-contract";
import { parseDocument } from "yaml";
import { z } from "zod";
import { CliError } from "../errors.js";

/** One run target. */
export type RunTarget =
  | { readonly kind: "file"; readonly name: string; readonly mode: 0o400 | 0o440 | 0o600 | 0o640 }
  | { readonly kind: "env"; readonly name: string };

/** One validated run entry. */
export interface RunEntry {
  readonly name: string;
  readonly targets: readonly RunTarget[];
  readonly optional: boolean;
}

/** A validated run manifest. */
export interface RunManifest {
  readonly project: string;
  readonly entries: readonly RunEntry[];
  readonly hash: string;
}

const MAX_MANIFEST_BYTES = 1_048_576;
const FILE_NAME = /^[A-Za-z0-9._-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ALLOWED_MODES = [0o400, 0o440, 0o600, 0o640] as const;
const RESERVED_ENV = new Set([
  "PATH",
  "HOME",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "BASH_ENV",
  "ENV",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PERL5OPT",
  "RUBYOPT",
  "GCONV_PATH",
]);

const rawEntrySchema = z.strictObject({
  name: secretNameSchema,
  file: z.string().optional(),
  env: z.string().optional(),
  mode: z.union([z.string(), z.number()]).optional(),
  optional: z.boolean().optional(),
});
const rawManifestSchema = z.strictObject({
  project: projectNameSchema,
  entries: z.array(rawEntrySchema).min(1).max(100),
});

/** Throws a stable manifest error. */
function invalid(message: string): never {
  throw new CliError("agent_manifest_invalid", message);
}

/** Parses one mode. */
function parseMode(value: string | number | undefined): 0o400 | 0o440 | 0o600 | 0o640 {
  if (value === undefined) {
    return 0o400;
  }
  let numeric: number;
  if (typeof value === "number") {
    const text = String(value);
    if (value === 0o400 || value === 0o440 || value === 0o600 || value === 0o640) {
      numeric = value;
    } else if (/^[0-7]{3}$/.test(text)) {
      // YAML parses an unquoted `0400` as the decimal number 400. Interpret
      // its digits as octal, which is what the field documents.
      numeric = Number.parseInt(text, 8);
    } else {
      numeric = value;
    }
  } else {
    const text = value.trim();
    if (!/^(?:0o)?0?[0-7]{3}$/.test(text)) {
      invalid("file mode must be 0400, 0440, 0600, or 0640");
    }
    numeric = Number.parseInt(text.replace(/^0o/, ""), 8);
  }
  const found = ALLOWED_MODES.find((allowed) => allowed === numeric);
  if (found === undefined) {
    invalid("file mode must be 0400, 0440, 0600, or 0640");
  }
  return found;
}

/** Returns true for a loader-affecting environment name. */
function isReservedEnv(name: string): boolean {
  return (
    RESERVED_ENV.has(name) ||
    name.startsWith("LD_") ||
    name.startsWith("DYLD_") ||
    name.startsWith("GIT_CONFIG_") ||
    name.startsWith("OPENVAULT_")
  );
}

/**
 * Loads and validates the CLI run manifest.
 *
 * @param path - Absolute manifest path.
 * @param expectedProject - Optional `--project` value.
 * @returns The validated manifest.
 */
export function loadRunManifest(path: string, expectedProject?: string): RunManifest {
  let bytes: Buffer;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
      invalid("manifest must be a regular file no larger than 1 MiB");
    }
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    invalid("manifest could not be read");
  }
  const document = parseDocument(bytes.toString("utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) {
    invalid("manifest YAML is invalid or contains duplicate keys");
  }
  let raw: unknown;
  try {
    raw = document.toJS() as unknown;
  } catch {
    invalid("manifest YAML could not be resolved");
  }
  const parsed = rawManifestSchema.safeParse(raw);
  if (!parsed.success) {
    invalid("manifest does not match the required schema");
  }
  if (expectedProject !== undefined && parsed.data.project !== expectedProject) {
    invalid("manifest project must equal --project");
  }
  const names = new Set<string>();
  const files = new Set<string>();
  const envNames = new Set<string>();
  const entries: RunEntry[] = [];
  for (const entry of parsed.data.entries) {
    if (names.has(entry.name)) {
      invalid("manifest secret names must be unique");
    }
    names.add(entry.name);
    const targets: RunTarget[] = [];
    if (entry.file !== undefined) {
      if (
        !FILE_NAME.test(entry.file) ||
        entry.file === "." ||
        entry.file === ".." ||
        entry.file.includes("/") ||
        entry.file.includes("\\")
      ) {
        invalid("file targets must be safe names without separators or dot segments");
      }
      if (files.has(entry.file)) {
        invalid("manifest file targets must be unique");
      }
      files.add(entry.file);
      targets.push({ kind: "file", name: entry.file, mode: parseMode(entry.mode) });
    } else if (entry.mode !== undefined) {
      invalid("file mode requires a file target");
    }
    if (entry.env !== undefined) {
      if (!ENV_NAME.test(entry.env) || isReservedEnv(entry.env)) {
        invalid("env targets must be safe loader-independent variable names");
      }
      if (envNames.has(entry.env)) {
        invalid("manifest env targets must be unique");
      }
      envNames.add(entry.env);
      targets.push({ kind: "env", name: entry.env });
    }
    if (targets.length === 0) {
      invalid("each entry requires a file or env target");
    }
    entries.push({ name: entry.name, targets, optional: entry.optional ?? false });
  }
  return {
    project: parsed.data.project,
    entries,
    hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}
