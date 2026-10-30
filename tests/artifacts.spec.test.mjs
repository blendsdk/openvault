import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "openvault-artifacts-"));
  fixtures.push(root);
  return root;
}

function writeFile(root, relativePath, content = "export const value = 1;\n") {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function runCheck(root) {
  return spawnSync(process.execPath, ["scripts/check-artifacts.mjs", "--root", root], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

describe("check-artifacts", () => {
  it("should pass a clean build tree and skip test-support and docs output", () => {
    const root = makeRoot();
    writeFile(root, "apps/web/dist/assets/index.js");
    writeFile(root, "apps/server/dist/main.js");
    writeFile(root, "packages/core/dist/index.js");
    writeFile(root, "packages/api-contract/dist/index.js");
    writeFile(root, "packages/core/dist/keyring.js");
    writeFile(root, "packages/core/dist/keyring.d.ts");
    writeFile(root, "packages/test-support/src/sentinels.ts", "SENTINEL_DO_NOT_LEAK_7f3a\n");
    writeFile(root, "docs/.vitepress/dist/index.html");

    const result = runCheck(root);
    expect(result.status).toBe(0);
  });

  it("should fail on source maps, env files, keys, and private-key markers", () => {
    const root = makeRoot();
    writeFile(root, "apps/server/dist/main.js.map");
    writeFile(root, "apps/server/dist/.env", "OPENVAULT_DB_URL=postgres://test\n");
    writeFile(root, "apps/server/dist/server.key", "not-a-real-key\n");
    writeFile(
      root,
      "packages/core/dist/index.js",
      "-----BEGIN PRIVATE KEY-----\nnot-real\n-----END PRIVATE KEY-----\n",
    );

    const result = runCheck(root);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output).toContain("main.js.map");
    expect(output).toContain(".env");
    expect(output).toContain("server.key");
    expect(output).toMatch(/private key/i);
  });

  it("should fail when the test sentinel appears in a production artifact", () => {
    const root = makeRoot();
    writeFile(root, "apps/web/dist/assets/index.js", "SENTINEL_DO_NOT_LEAK_7f3a\n");

    const result = runCheck(root);
    expect(result.status).toBe(1);
  });

  it("should fail an audit fixture with a high advisory and pass a low one", () => {
    const root = makeRoot();
    const high = join(root, "high.json");
    const low = join(root, "low.json");
    writeFile(root, "high.json", JSON.stringify({ advisories: { 1: { severity: "high" } } }));
    writeFile(root, "low.json", JSON.stringify({ advisories: { 1: { severity: "low" } } }));

    const highResult = spawnSync(process.execPath, ["scripts/audit-check.mjs", high], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const lowResult = spawnSync(process.execPath, ["scripts/audit-check.mjs", low], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(highResult.status).toBe(1);
    expect(lowResult.status).toBe(0);
  });
});
