#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const TARGETS = ["react", "@griffel/react"];

/**
 * Reads and parses a package manifest.
 *
 * @param {string} packageJsonPath - Absolute path to a `package.json` file.
 * @returns {{ name: string, version: string } | null} Parsed identity, or `null` when the
 * file is unreadable or malformed.
 */
function readPackageIdentity(packageJsonPath) {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (typeof parsed.name !== "string" || typeof parsed.version !== "string") {
      return null;
    }
    return { name: parsed.name, version: parsed.version };
  } catch {
    return null;
  }
}

/**
 * Records a target package when the directory looks like an installed package, then scans
 * any nested `node_modules` directory. Nested installs are where duplicate versions usually
 * hide.
 *
 * @param {string} packageDirectory - Candidate package directory.
 * @param {Map<string, Array<{ version: string, path: string }>>} found - Accumulator.
 * @param {Set<string>} seen - Deduplication set keyed by package name and manifest path.
 */
function inspectPackage(packageDirectory, found, seen) {
  const packageJsonPath = join(packageDirectory, "package.json");
  if (existsSync(packageJsonPath)) {
    const identity = readPackageIdentity(packageJsonPath);
    if (identity && TARGETS.includes(identity.name)) {
      const key = `${identity.name}\0${packageJsonPath}`;
      if (!seen.has(key)) {
        seen.add(key);
        const entries = found.get(identity.name) ?? [];
        entries.push({ version: identity.version, path: packageJsonPath });
        found.set(identity.name, entries);
      }
    }
  }

  const nestedNodeModules = join(packageDirectory, "node_modules");
  if (existsSync(nestedNodeModules)) {
    scanNodeModules(nestedNodeModules, found, seen);
  }
}

/**
 * Walks a `node_modules` directory without following symlinks.
 *
 * pnpm stores real package directories under `.pnpm/<id>/node_modules`; direct entries in
 * the workspace `node_modules` are symlinks. The scanner therefore visits each virtual-store
 * package directory explicitly and skips symlinked entries to avoid cycles.
 *
 * @param {string} nodeModulesDirectory - Directory to scan.
 * @param {Map<string, Array<{ version: string, path: string }>>} found - Accumulator.
 * @param {Set<string>} seen - Deduplication set.
 */
function scanNodeModules(nodeModulesDirectory, found, seen) {
  if (!existsSync(nodeModulesDirectory)) {
    return;
  }

  for (const entry of readdirSync(nodeModulesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }

    if (entry.name === ".pnpm") {
      const virtualStore = join(nodeModulesDirectory, entry.name);
      for (const stored of readdirSync(virtualStore, { withFileTypes: true })) {
        if (!stored.isDirectory() || stored.isSymbolicLink()) {
          continue;
        }
        scanNodeModules(join(virtualStore, stored.name, "node_modules"), found, seen);
      }
      continue;
    }

    if (entry.name.startsWith("@")) {
      const scopeDirectory = join(nodeModulesDirectory, entry.name);
      for (const scoped of readdirSync(scopeDirectory, { withFileTypes: true })) {
        if (scoped.isDirectory() && !scoped.isSymbolicLink()) {
          inspectPackage(join(scopeDirectory, scoped.name), found, seen);
        }
      }
      continue;
    }

    inspectPackage(join(nodeModulesDirectory, entry.name), found, seen);
  }
}

/**
 * Formats one version per line with every manifest path that declares it.
 *
 * @param {Array<{ version: string, path: string }>} entries - Installed copies.
 * @returns {string} Human-readable version report.
 */
function formatEntries(entries) {
  const byVersion = new Map();
  for (const entry of entries) {
    const paths = byVersion.get(entry.version) ?? [];
    paths.push(entry.path);
    byVersion.set(entry.version, paths);
  }
  return [...byVersion.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([version, paths]) => `  ${version}  ${paths.join(", ")}`)
    .join("\n");
}

/**
 * Parses command-line arguments.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{ root: string }} Resolved workspace root.
 * @throws {Error} When an option is unknown or `--root` has no value.
 */
function parseArguments(argv) {
  let root = process.cwd();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--root requires a directory");
      }
      root = value;
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: check-single-react.mjs [--root <workspace>]\n");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { root: resolve(root) };
}

/**
 * Checks that the workspace has one React version and one Griffel version.
 *
 * A duplicate version is a rendering and hook-order defect waiting to happen, so this is a
 * hard build gate rather than a warning.
 *
 * @returns {number} Process exit code.
 */
function main() {
  let root;
  try {
    ({ root } = parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const nodeModulesDirectory = join(root, "node_modules");
  if (!existsSync(nodeModulesDirectory)) {
    process.stderr.write(`Missing node_modules directory: ${nodeModulesDirectory}\n`);
    return 1;
  }

  const found = new Map();
  scanNodeModules(nodeModulesDirectory, found, new Set());

  let failed = false;
  for (const target of TARGETS) {
    const entries = found.get(target) ?? [];
    if (entries.length === 0) {
      process.stderr.write(`Missing required package: ${target}\n`);
      failed = true;
      continue;
    }

    const versions = new Set(entries.map((entry) => entry.version));
    if (versions.size > 1) {
      process.stderr.write(`Duplicate ${target} versions:\n${formatEntries(entries)}\n`);
      failed = true;
    }
  }

  if (failed) {
    return 1;
  }

  process.stdout.write("React and Griffel versions are unique.\n");
  return 0;
}

process.exit(main());
