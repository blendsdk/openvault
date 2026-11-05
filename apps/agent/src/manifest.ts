import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { identityNameSchema, projectNameSchema, secretNameSchema } from "@openvault/api-contract";
import { parseDocument } from "yaml";
import { z } from "zod";
import { AgentError } from "./errors.js";

/** Delivery mode selected by the command line. */
export type ManifestMode = "sidecar" | "wrapper";

/** One file target in a manifest entry. */
export interface ManifestFileTarget {
  /** Safe file name below the output root. */
  readonly name: string;
  /** Final file mode. */
  readonly mode: 0o400 | 0o440 | 0o600 | 0o640;
}

/** One environment target in a manifest entry. */
export interface ManifestEnvTarget {
  /** Environment variable name. */
  readonly name: string;
}

/** One manifest entry. */
export interface ManifestEntry {
  /** Secret name. */
  readonly name: string;
  /** File targets. */
  readonly files: readonly ManifestFileTarget[];
  /** Environment targets. */
  readonly env: readonly ManifestEnvTarget[];
  /** Whether a failure may degrade rather than fail the cycle. */
  readonly optional: boolean;
}

/** A validated manifest. */
export interface AgentManifest {
  /** OpenVault project name. */
  readonly project: string;
  /** Service identity name. */
  readonly service: string;
  /** Refresh interval in milliseconds. */
  readonly refreshMs: number;
  /** Output directory inside the container. */
  readonly outputDir: string;
  /** Entries in manifest order. */
  readonly entries: readonly ManifestEntry[];
  /** SHA-256 of the raw manifest bytes. */
  readonly hash: string;
}

/** Options for {@link loadAgentManifest}. */
export interface LoadManifestOptions {
  /** Expected project from the environment. */
  readonly project: string;
  /** Expected service from the environment. */
  readonly service: string;
  /** Expected output directory from the environment. */
  readonly outputDir: string;
  /** Delivery mode; sidecar rejects `env` targets. */
  readonly mode: ManifestMode;
}

const MAX_MANIFEST_BYTES = 1_048_576;
const MIN_REFRESH_MS = 30_000;
const MAX_REFRESH_MS = 86_400_000;
const ALLOWED_MODES = [0o400, 0o440, 0o600, 0o640] as const;
const FILE_NAME = /^[A-Za-z0-9._-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED_ENV = new Set([
  "PATH",
  "HOME",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "PYTHONPATH",
  "PERL5OPT",
  "RUBYOPT",
]);

const refreshSchema = z.union([z.string(), z.number()]);
const modeSchema = z.union([z.string(), z.number()]);
const rawEntrySchema = z.strictObject({
  name: secretNameSchema,
  file: z.string().optional(),
  env: z.string().optional(),
  mode: modeSchema.optional(),
  optional: z.boolean().optional(),
});
const rawManifestSchema = z.strictObject({
  project: projectNameSchema,
  service: identityNameSchema,
  refresh: refreshSchema.optional(),
  output_dir: z.string(),
  entries: z.array(rawEntrySchema).min(1).max(100),
});

/** Throws a stable manifest error. */
function invalid(message: string): never {
  throw new AgentError("agent_manifest_invalid", message);
}

/** Parses a refresh duration into milliseconds. */
function parseRefresh(value: string | number | undefined): number {
  if (value === undefined) {
    return 300_000;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      invalid("refresh must be a whole number of seconds");
    }
    const ms = value * 1_000;
    if (ms < MIN_REFRESH_MS || ms > MAX_REFRESH_MS) {
      invalid("refresh must be between 30s and 24h");
    }
    return ms;
  }
  const match = /^(\d+)(s|m|h)?$/.exec(value.trim());
  if (match === null) {
    invalid("refresh must be a duration such as 300s, 5m, or 1h");
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
  const ms = amount * multiplier;
  if (!Number.isInteger(ms) || ms < MIN_REFRESH_MS || ms > MAX_REFRESH_MS) {
    invalid("refresh must be between 30s and 24h");
  }
  return ms;
}

/** Parses one file mode. */
function parseMode(value: string | number | undefined): 0o400 | 0o440 | 0o600 | 0o640 {
  if (value === undefined) {
    return 0o400;
  }
  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
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

/** Returns true for an environment name that can affect process loading. */
function isReservedEnv(name: string): boolean {
  return (
    RESERVED_ENV.has(name) ||
    name.startsWith("LD_") ||
    name.startsWith("DYLD_") ||
    name.startsWith("OPENVAULT_")
  );
}

/**
 * Loads and validates a manifest.
 *
 * The file is read once; a change requires a restart. Unknown fields,
 * duplicate YAML keys, unsafe paths, duplicate targets, and environment
 * disagreement all fail before any network request.
 *
 * @param path - Absolute manifest path.
 * @param options - Expected environment values and delivery mode.
 * @returns The validated manifest.
 * @throws {AgentError} `agent_manifest_invalid`.
 */
export function loadAgentManifest(path: string, options: LoadManifestOptions): AgentManifest {
  let bytes: Buffer;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
      invalid("manifest must be a regular file no larger than 1 MiB");
    }
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof AgentError) {
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
  if (parsed.data.project !== options.project) {
    invalid("manifest project must equal OPENVAULT_PROJECT");
  }
  if (parsed.data.service !== options.service) {
    invalid("manifest service must equal OPENVAULT_SERVICE");
  }
  if (parsed.data.output_dir !== options.outputDir) {
    invalid("manifest output_dir must equal OPENVAULT_OUTPUT_DIR");
  }

  const names = new Set<string>();
  const files = new Set<string>();
  const envNames = new Set<string>();
  const entries: ManifestEntry[] = [];
  for (const entry of parsed.data.entries) {
    if (names.has(entry.name)) {
      invalid("manifest secret names must be unique");
    }
    names.add(entry.name);

    const fileTargets: ManifestFileTarget[] = [];
    const envTargets: ManifestEnvTarget[] = [];
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
      fileTargets.push({ name: entry.file, mode: parseMode(entry.mode) });
    } else if (entry.mode !== undefined) {
      invalid("file mode requires a file target");
    }
    if (entry.env !== undefined) {
      if (options.mode === "sidecar") {
        invalid("env targets are not allowed in sidecar mode");
      }
      if (!ENV_NAME.test(entry.env) || isReservedEnv(entry.env)) {
        invalid("env targets must be safe loader-independent variable names");
      }
      if (envNames.has(entry.env)) {
        invalid("manifest env targets must be unique");
      }
      envNames.add(entry.env);
      envTargets.push({ name: entry.env });
    }
    if (fileTargets.length === 0 && envTargets.length === 0) {
      invalid("each entry requires a file or env target");
    }
    entries.push({
      name: entry.name,
      files: fileTargets,
      env: envTargets,
      optional: entry.optional ?? false,
    });
  }

  return Object.freeze({
    project: parsed.data.project,
    service: parsed.data.service,
    refreshMs: parseRefresh(parsed.data.refresh),
    outputDir: parsed.data.output_dir,
    entries: Object.freeze(entries),
    hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
}
