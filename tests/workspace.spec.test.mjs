import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const rootPackage = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8"));

/**
 * Reads a workspace package manifest.
 *
 * @param {string} relativePath - Package directory relative to the workspace root.
 * @returns {Record<string, unknown>} Parsed manifest.
 */
function readManifest(relativePath) {
  return JSON.parse(readFileSync(join(workspaceRoot, relativePath, "package.json"), "utf8"));
}

/**
 * Expands the simple `apps/*` and `packages/*` patterns declared in the workspace file.
 *
 * Keeping this test tied to the real workspace list prevents a future package from silently
 * skipping the test-script requirement.
 *
 * @returns {string[]} Sorted package directories.
 */
function workspacePackageDirectories() {
  const workspaceFile = readFileSync(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8");
  const lines = workspaceFile.split("\n");
  const patterns = [];
  let inPackages = false;

  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    const match = line.match(/^\s*-\s*["']?([^"']+)["']?\s*$/);
    if (!match) {
      if (line.trim() !== "") {
        break;
      }
      continue;
    }
    patterns.push(match[1]);
  }

  const directories = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      for (const entry of readdirSync(join(workspaceRoot, parent), { withFileTypes: true })) {
        if (entry.isDirectory()) {
          directories.push(join(parent, entry.name));
        }
      }
      continue;
    }
    directories.push(pattern);
  }

  return directories.sort();
}

describe("workspace policy", () => {
  it("should keep the core package free of production dependencies", () => {
    const manifest = readManifest("packages/core");
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it("should give every workspace package a test script", () => {
    for (const relativePath of workspacePackageDirectories()) {
      const manifest = readManifest(relativePath);
      expect(manifest.scripts?.test, `${relativePath} has a test script`).toBeTypeOf("string");
    }
  });

  it("should run workspace tests without silently skipping packages", () => {
    expect(rootPackage.scripts["test:unit"]).toBe("pnpm -r test");
  });

  it("should run the canonical verification steps in dependency order", () => {
    const expected = [
      "pnpm build",
      "pnpm typecheck",
      "pnpm lint",
      "pnpm test",
      "pnpm check:react",
      "pnpm docs:build",
    ];

    expect(rootPackage.scripts.verify.split(" && ").map((step) => step.trim())).toEqual(expected);
  });
});
