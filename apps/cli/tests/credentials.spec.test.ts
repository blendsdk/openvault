import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCredentialPaths } from "../src/credentials/paths.js";
import { type CredentialDocument, CredentialStore } from "../src/credentials/store.js";
import { CliError } from "../src/errors.js";

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openvault-cli-credentials-"));
  directories.push(directory);
  return directory;
}

function document(): CredentialDocument {
  return {
    version: 1,
    baseUrl: "https://vault.example.test",
    accessToken: "access",
    refreshToken: "R".repeat(43),
    accessExpiresAt: "2026-11-05T12:15:00.000Z",
    refreshExpiresAt: "2026-11-06T00:00:00.000Z",
  };
}

function storeFor(directory: string): CredentialStore {
  return new CredentialStore({
    env: { HOME: directory, XDG_CONFIG_HOME: join(directory, "config") },
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("credential paths", () => {
  it("should use XDG_CONFIG_HOME when set", () => {
    const paths = resolveCredentialPaths({ XDG_CONFIG_HOME: "/tmp/xdg" }, "linux", "/home/ada");
    expect(paths.directory).toBe("/tmp/xdg/openvault");
  });

  it("should use the Linux, macOS, and Windows defaults", () => {
    expect(resolveCredentialPaths({}, "linux", "/home/ada").directory).toBe(
      "/home/ada/.config/openvault",
    );
    expect(resolveCredentialPaths({}, "darwin", "/Users/ada").directory).toBe(
      "/Users/ada/Library/Application Support/openvault",
    );
    expect(
      resolveCredentialPaths({ APPDATA: "C:\\Users\\ada\\AppData" }, "win32", "").directory,
    ).toBe(win32.join("C:\\Users\\ada\\AppData", "openvault"));
  });

  it("should reject a relative XDG_CONFIG_HOME", () => {
    expect(() =>
      resolveCredentialPaths({ XDG_CONFIG_HOME: "relative" }, "linux", "/home/ada"),
    ).toThrow(/absolute/);
  });
});

describe("credential store", () => {
  it("should write a 0700 directory and a 0600 file", () => {
    const directory = tempDirectory();
    const store = storeFor(directory);
    store.save(document());
    expect(statSync(store.directory).mode & 0o777).toBe(0o700);
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(store.load()).toEqual(document());
  });

  it("should reject a symlink and a loose directory", () => {
    const directory = tempDirectory();
    const store = storeFor(directory);
    store.save(document());
    const target = join(directory, "target.json");
    writeFileSync(target, JSON.stringify(document()), { mode: 0o600 });
    rmSync(store.file);
    symlinkSync(target, store.file);
    expect(() => store.load()).toThrow(/symlink/i);
    rmSync(store.file);
    chmodSync(store.directory, 0o755);
    expect(() => store.load()).toThrow(/0700/);
  });

  it("should reject corrupt JSON and unknown versions", () => {
    const directory = tempDirectory();
    const store = storeFor(directory);
    store.save(document());
    writeFileSync(store.file, "{not json", { mode: 0o600 });
    expect(() => store.load()).toThrow(/JSON/);
    writeFileSync(store.file, JSON.stringify({ ...document(), version: 2 }), { mode: 0o600 });
    expect(() => store.load()).toThrow(/valid/);
  });

  it("should serialize concurrent locked writers", async () => {
    const directory = tempDirectory();
    const store = storeFor(directory);
    const events: string[] = [];
    await Promise.all([
      store.withLock(async () => {
        events.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 50));
        events.push("a-end");
      }),
      store.withLock(async () => {
        events.push("b-start");
        events.push("b-end");
      }),
    ]);
    expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("should create a 0600 lock and reclaim a stale dead-process lock", async () => {
    const directory = tempDirectory();
    const store = storeFor(directory);
    store.save(document());
    await store.withLock(() => {
      expect(statSync(store.lockFile).mode & 0o777).toBe(0o600);
    });
    expect(existsSync(store.lockFile)).toBe(false);

    writeFileSync(
      store.lockFile,
      JSON.stringify({
        pid: 2_147_483_647,
        createdAt: new Date(Date.now() - 120_000).toISOString(),
        owner: "dead",
      }),
      { mode: 0o600 },
    );
    const result = await store.withLock(() => "ran");
    expect(result).toBe("ran");
    expect(existsSync(store.lockFile)).toBe(false);
  });

  it("should remove the credential file", () => {
    const directory = tempDirectory();
    const store = storeFor(directory);
    store.save(document());
    store.remove();
    expect(store.load()).toBeUndefined();
  });

  it("should fail closed on native Windows", () => {
    expect(
      () => new CredentialStore({ env: { APPDATA: "C:\\Users\\ada" }, platform: "win32" }),
    ).toThrow(CliError);
  });
});
