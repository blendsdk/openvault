#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const SENTINEL = "SENTINEL_DO_NOT_LEAK_7f3a";
const PRIVATE_KEY_MARKER = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

/**
 * Parses the optional `--root` argument.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @returns {string} Absolute workspace root.
 */
function parseRoot(argv) {
  const index = argv.indexOf("--root");
  if (index === -1) {
    return process.cwd();
  }
  const value = argv[index + 1];
  if (!value) {
    throw new Error("--root requires a directory");
  }
  return resolve(value);
}

/**
 * Lists build directories that may contain production artifacts.
 *
 * @param {string} root - Workspace root.
 * @returns {string[]} Existing build directories.
 */
function buildDirectories(root) {
  const directories = [];
  const appsDirectory = join(root, "apps");
  if (existsSync(appsDirectory)) {
    for (const entry of readdirSync(appsDirectory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        directories.push(join(appsDirectory, entry.name, "dist"));
      }
    }
  }
  directories.push(join(root, "packages", "core", "dist"));
  directories.push(join(root, "packages", "api-contract", "dist"));
  return directories.filter((directory) => existsSync(directory));
}

/**
 * Collects regular files below a directory without following symlinks.
 *
 * @param {string} directory - Directory to walk.
 * @returns {string[]} File paths.
 */
function filesBelow(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesBelow(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Returns a human-readable violation reason, or `null` when the file is allowed.
 *
 * @param {string} path - File path.
 * @returns {string | null} Violation reason.
 */
function nameViolation(path) {
  const name = basename(path);
  if (name.endsWith(".map")) {
    return "source map";
  }
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
    return "environment file";
  }
  if (name === "keyring.json" || name.endsWith(".keyring")) {
    return "keyring material";
  }
  if (
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    name.endsWith(".p12") ||
    name.endsWith(".pfx")
  ) {
    return "key material";
  }
  return null;
}

/**
 * Scans file contents for sentinel values and private keys.
 *
 * @param {string} path - File path.
 * @returns {string | null} Violation reason.
 */
function contentViolation(path) {
  if (statSync(path).size > 5 * 1024 * 1024) {
    return null;
  }
  const content = readFileSync(path, "utf8");
  if (content.includes(SENTINEL)) {
    return "test sentinel value";
  }
  if (PRIVATE_KEY_MARKER.test(content)) {
    return "private key marker";
  }
  return null;
}

/**
 * Runs the build-artifact check.
 *
 * @returns {number} Process exit code.
 */
function main() {
  let root;
  try {
    root = parseRoot(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const violations = [];
  for (const directory of buildDirectories(root)) {
    for (const path of filesBelow(directory)) {
      const reason = nameViolation(path) ?? contentViolation(path);
      if (reason) {
        violations.push(`${path}: ${reason}`);
      }
    }
  }

  if (violations.length > 0) {
    for (const violation of violations) {
      process.stderr.write(`${violation}\n`);
    }
    return 1;
  }

  process.stdout.write("Build artifacts are clean.\n");
  return 0;
}

process.exitCode = main();
