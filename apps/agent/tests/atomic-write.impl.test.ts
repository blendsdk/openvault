import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { abortStaged, atomicWriteFile, commitStaged, stageFile } from "../src/fs-utils.js";

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openvault-agent-atomic-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("atomic writes", () => {
  it("should stage every target before renaming any of them", () => {
    const directory = tempDirectory();
    const first = join(directory, "first");
    const second = join(directory, "second");
    const staged = [stageFile(first, "one", 0o400), stageFile(second, "two", 0o600)];
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    commitStaged(staged);
    expect(readFileSync(first, "utf8")).toBe("one");
    expect(readFileSync(second, "utf8")).toBe("two");
    expect(statSync(first).mode & 0o777).toBe(0o400);
    expect(statSync(second).mode & 0o777).toBe(0o600);
  });

  it("should remove staged temporaries on abort", () => {
    const directory = tempDirectory();
    const target = join(directory, "target");
    const staged = [stageFile(target, "value", 0o400)];
    expect(staged[0]?.temporary).toBeDefined();
    abortStaged(staged);
    expect(existsSync(staged[0]?.temporary ?? "")).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("should replace an existing target atomically", () => {
    const directory = tempDirectory();
    const target = join(directory, "target");
    atomicWriteFile(target, "first", 0o400);
    atomicWriteFile(target, "second", 0o600);
    expect(readFileSync(target, "utf8")).toBe("second");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});
