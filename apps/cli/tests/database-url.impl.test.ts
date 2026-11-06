import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { databaseUrlFromEnv } from "../src/commands/database-url.js";
import { CliError } from "../src/errors.js";
import type { CliRuntime } from "../src/types.js";

const directories: string[] = [];

function runtime(env: NodeJS.ProcessEnv, cwd = tmpdir()): CliRuntime {
  return {
    env,
    cwd,
    stdout: () => undefined,
    stderr: () => undefined,
    stdin: Readable.from([]),
    isTty: false,
    now: Date.now,
  };
}

function secretFile(contents: string, mode = 0o444): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "openvault-cli-db-url-"));
  directories.push(directory);
  const path = join(directory, "db-url");
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return { directory, path };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database URL environment", () => {
  it("reads a direct URL", () => {
    expect(databaseUrlFromEnv(runtime({ OPENVAULT_DB_URL: " postgres://a:b@c/d " }))).toBe(
      "postgres://a:b@c/d",
    );
  });

  it("reads a file-backed URL", () => {
    const file = secretFile("postgres://app:secret@db:5432/openvault\n");
    expect(databaseUrlFromEnv(runtime({ OPENVAULT_DB_URL_FILE: file.path }, file.directory))).toBe(
      "postgres://app:secret@db:5432/openvault",
    );
  });

  it("rejects both forms and unsafe modes", () => {
    const file = secretFile("postgres://app:secret@db:5432/openvault\n");
    expect(() =>
      databaseUrlFromEnv(
        runtime({
          OPENVAULT_DB_URL: "postgres://direct:secret@db:5432/openvault",
          OPENVAULT_DB_URL_FILE: file.path,
        }),
      ),
    ).toThrowError(/cannot both be set/);

    const writable = secretFile("postgres://app:secret@db:5432/openvault\n", 0o620);
    expect(() =>
      databaseUrlFromEnv(runtime({ OPENVAULT_DB_URL_FILE: writable.path })),
    ).toThrowError(/group- or world-writable/);
  });

  it("requires a URL when the caller asks for one", () => {
    expect(() => databaseUrlFromEnv(runtime({}))).toThrowError(CliError);
    expect(databaseUrlFromEnv(runtime({}), "OPENVAULT_MIGRATION_DB_URL", false)).toBeUndefined();
  });
});
