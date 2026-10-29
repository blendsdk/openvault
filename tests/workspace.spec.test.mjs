import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const rootPackage = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8"));
const workspacePackages = [
  "apps/server",
  "apps/web",
  "packages/core",
  "packages/api-contract",
  "packages/test-support",
];

/**
 * Reads a workspace package manifest.
 *
 * @param {string} relativePath - Package directory relative to the workspace root.
 * @returns {Record<string, unknown>} Parsed manifest.
 */
function readManifest(relativePath) {
  return JSON.parse(readFileSync(join(workspaceRoot, relativePath, "package.json"), "utf8"));
}

describe("workspace policy", () => {
  it("should keep the core package free of production dependencies", () => {
    const manifest = readManifest("packages/core");
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it("should give every workspace package a test script", () => {
    for (const relativePath of workspacePackages) {
      const manifest = readManifest(relativePath);
      expect(manifest.scripts?.test, `${relativePath} has a test script`).toBeTypeOf("string");
    }
  });

  it("should run workspace tests without silently skipping packages", () => {
    expect(rootPackage.scripts["test:unit"]).toBe("pnpm -r test");
  });

  it("should run the canonical verification steps in dependency order", () => {
    const steps = [
      "pnpm build",
      "pnpm typecheck",
      "pnpm lint",
      "pnpm test",
      "pnpm check:artifacts",
      "pnpm check:react",
      "pnpm docs:build",
    ];
    const positions = steps.map((step) => rootPackage.scripts.verify.indexOf(step));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });
});
