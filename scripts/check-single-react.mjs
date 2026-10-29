#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const TARGETS = ["react", "@griffel/react"];

/**
 * Resolves a path to its canonical location.
 *
 * @param {string} path - Path to resolve.
 * @returns {string | null} Canonical path, or `null` for a broken link or unreadable path.
 */
function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

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
 * @param {string} packageDirectory - Candidate package directory or symlink to one.
 * @param {Map<string, Array<{ version: string, path: string }>>} found - Accumulator.
 * @param {Set<string>} seenPackages - Deduplication set keyed by canonical manifest path.
 * @param {Set<string>} visitedDirectories - Canonical directories already scanned.
 */
function inspectPackage(packageDirectory, found, seenPackages, visitedDirectories) {
  const canonicalDirectory = safeRealpath(packageDirectory);
  if (!canonicalDirectory) {
    return;
  }

  let stats;
  try {
    stats = statSync(canonicalDirectory);
  } catch {
    return;
  }
  if (!stats.isDirectory()) {
    return;
  }

  const packageJsonPath = join(canonicalDirectory, "package.json");
  if (existsSync(packageJsonPath)) {
    const identity = readPackageIdentity(packageJsonPath);
    if (identity && TARGETS.includes(identity.name)) {
      if (!seenPackages.has(packageJsonPath)) {
        seenPackages.add(packageJsonPath);
        const entries = found.get(identity.name) ?? [];
        entries.push({ version: identity.version, path: packageJsonPath });
        found.set(identity.name, entries);
      }
    }
  }

  scanNodeModules(
    join(canonicalDirectory, "node_modules"),
    found,
    seenPackages,
    visitedDirectories,
  );
}

/**
 * Walks a `node_modules` directory.
 *
 * pnpm stores real package directories under `.pnpm/<id>/node_modules`; workspace entries
 * are often symlinks. Following a symlink once and caching its canonical directory keeps the
 * walk cycle-safe while still catching linked duplicates.
 *
 * @param {string} nodeModulesDirectory - Directory to scan.
 * @param {Map<string, Array<{ version: string, path: string }>>} found - Accumulator.
 * @param {Set<string>} seenPackages - Deduplication set.
 * @param {Set<string>} visitedDirectories - Canonical directories already scanned.
 */
function scanNodeModules(nodeModulesDirectory, found, seenPackages, visitedDirectories) {
  const canonicalDirectory = safeRealpath(nodeModulesDirectory);
  if (!canonicalDirectory || visitedDirectories.has(canonicalDirectory)) {
    return;
  }

  let stats;
  try {
    stats = statSync(canonicalDirectory);
  } catch {
    return;
  }
  if (!stats.isDirectory()) {
    return;
  }
  visitedDirectories.add(canonicalDirectory);

  let entries;
  try {
    entries = readdirSync(canonicalDirectory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = join(canonicalDirectory, entry.name);
    const canonicalEntry = safeRealpath(entryPath);
    if (!canonicalEntry) {
      continue;
    }

    let entryStats;
    try {
      entryStats = statSync(canonicalEntry);
    } catch {
      continue;
    }
    if (!entryStats.isDirectory()) {
      continue;
    }

    if (entry.name === ".pnpm") {
      let storedPackages;
      try {
        storedPackages = readdirSync(canonicalEntry, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const stored of storedPackages) {
        if (!stored.isDirectory() && !stored.isSymbolicLink()) {
          continue;
        }
        scanNodeModules(
          join(canonicalEntry, stored.name, "node_modules"),
          found,
          seenPackages,
          visitedDirectories,
        );
      }
      continue;
    }

    if (entry.name.startsWith("@")) {
      let scopedPackages;
      try {
        scopedPackages = readdirSync(canonicalEntry, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scoped of scopedPackages) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) {
          continue;
        }
        inspectPackage(join(canonicalEntry, scoped.name), found, seenPackages, visitedDirectories);
      }
      continue;
    }

    inspectPackage(canonicalEntry, found, seenPackages, visitedDirectories);
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
  scanNodeModules(nodeModulesDirectory, found, new Set(), new Set());

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
