import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures = [];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "openvault-react-"));
  fixtures.push(root);
  return root;
}

function writePackage(root, relativePath, name, version) {
  const directory = join(root, relativePath);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version }, null, 2));
}

function runCheck(root) {
  return spawnSync(process.execPath, ["scripts/check-single-react.mjs", "--root", root], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

describe("check-single-react", () => {
  it("should fail and print both paths when two React versions are installed", () => {
    const root = makeFixture();
    writePackage(root, "node_modules/react", "react", "19.2.0");
    writePackage(root, "node_modules/feature/node_modules/react", "react", "19.3.1");
    writePackage(root, "node_modules/@griffel/react", "@griffel/react", "1.7.8");

    const result = runCheck(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("19.2.0");
    expect(output).toContain("19.3.1");
    expect(output).toContain(join(root, "node_modules/react/package.json"));
    expect(output).toContain(join(root, "node_modules/feature/node_modules/react/package.json"));
  });

  it("should fail and print both paths when two Griffel versions are installed", () => {
    const root = makeFixture();
    writePackage(root, "node_modules/react", "react", "19.3.1");
    writePackage(root, "node_modules/@griffel/react", "@griffel/react", "1.7.8");
    writePackage(
      root,
      "node_modules/feature/node_modules/@griffel/react",
      "@griffel/react",
      "1.8.0",
    );

    const result = runCheck(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("1.7.8");
    expect(output).toContain("1.8.0");
    expect(output).toContain(join(root, "node_modules/@griffel/react/package.json"));
    expect(output).toContain(
      join(root, "node_modules/feature/node_modules/@griffel/react/package.json"),
    );
  });

  it("should pass when React and Griffel each have exactly one version", () => {
    const root = makeFixture();
    writePackage(root, "node_modules/react", "react", "19.3.1");
    writePackage(root, "node_modules/@griffel/react", "@griffel/react", "1.7.8");

    const result = runCheck(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain("unique");
  });

  it("should fail when a required package is missing", () => {
    const root = makeFixture();
    writePackage(root, "node_modules/react", "react", "19.3.1");

    const result = runCheck(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("@griffel/react");
  });

  it("should find packages in pnpm's virtual store", () => {
    const root = makeFixture();
    writePackage(root, "node_modules/.pnpm/react@19.2.0/node_modules/react", "react", "19.2.0");
    writePackage(root, "node_modules/.pnpm/react@19.3.1/node_modules/react", "react", "19.3.1");
    writePackage(
      root,
      "node_modules/.pnpm/@griffel+react@1.7.8/node_modules/@griffel/react",
      "@griffel/react",
      "1.7.8",
    );

    const result = runCheck(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("19.2.0");
    expect(output).toContain("19.3.1");
  });

  it("should follow package symlinks without looping", () => {
    const root = makeFixture();
    writePackage(root, "vendor/react-a", "react", "19.2.0");
    writePackage(root, "vendor/react-b", "react", "19.3.1");
    writePackage(root, "node_modules/@griffel/react", "@griffel/react", "1.7.8");

    mkdirSync(join(root, "node_modules/feature/node_modules"), { recursive: true });
    symlinkSync(join(root, "vendor/react-a"), join(root, "node_modules/react"), "dir");
    symlinkSync(
      join(root, "vendor/react-b"),
      join(root, "node_modules/feature/node_modules/react"),
      "dir",
    );

    const result = runCheck(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("19.2.0");
    expect(output).toContain("19.3.1");
  });
});
