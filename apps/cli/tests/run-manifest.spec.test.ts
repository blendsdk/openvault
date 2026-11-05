import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunManifest } from "../src/run/manifest.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function manifest(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), "openvault-run-manifest-"));
  directories.push(directory);
  const path = join(directory, "openvault.run.yaml");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("CLI run manifest", () => {
  it("should accept an unquoted YAML mode and treat its digits as octal", () => {
    const parsed = loadRunManifest(
      manifest(
        [
          "project: payments",
          "entries:",
          "  - name: db",
          "    file: db",
          "    mode: 0400",
          "",
        ].join("\n"),
      ),
    );
    expect(parsed.entries[0]?.targets[0]).toEqual({ kind: "file", name: "db", mode: 0o400 });
  });

  it("should reject a duplicate YAML key and an unsafe environment name", () => {
    expect(() =>
      loadRunManifest(
        manifest(["project: payments", "project: payments", "entries: []", ""].join("\n")),
      ),
    ).toThrow(/duplicate/i);
    expect(() =>
      loadRunManifest(
        manifest(
          ["project: payments", "entries:", "  - name: db", "    env: LD_PRELOAD", ""].join("\n"),
        ),
      ),
    ).toThrow(/env/i);
  });

  it("should reject a project mismatch", () => {
    expect(() =>
      loadRunManifest(
        manifest(["project: payments", "entries:", "  - name: db", "    env: DB", ""].join("\n")),
        "other",
      ),
    ).toThrow(/project/i);
  });
});
