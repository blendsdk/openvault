import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { KeyringProvider } from "../src/security/keyring.js";
import { writeFixtureFile } from "./helpers/config-fixture.js";

let directory: string | undefined;

afterEach(() => {
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

function fixtureDirectory(): string {
  directory = mkdtempSync(join(tmpdir(), "openvault-keyring-"));
  return directory;
}

function keyringJson(current = "k1"): string {
  return JSON.stringify({
    version: 1,
    current,
    keys: {
      k1: Buffer.alloc(32, 1).toString("base64"),
      k2: Buffer.alloc(32, 2).toString("base64"),
    },
  });
}

describe("keyring provider loading", () => {
  it("loads a 0600 keyring and reports status without key bytes", async () => {
    const directoryPath = fixtureDirectory();
    const path = writeFixtureFile(directoryPath, "keyring.json", keyringJson("k2"));

    const provider = await KeyringProvider.load(path);
    const status = provider.status();

    expect(status.loaded).toBe(true);
    expect(status.currentId).toBe("k2");
    expect(status.keyCount).toBe(2);
    expect(JSON.stringify(status)).not.toContain(Buffer.alloc(32, 1).toString("base64"));

    provider.destroy();
  });

  it("rejects a keyring file that is not exactly 0600", async () => {
    const directoryPath = fixtureDirectory();
    const path = writeFixtureFile(directoryPath, "keyring.json", keyringJson(), 0o644);

    await expect(KeyringProvider.load(path)).rejects.toThrow(/0600|permission|mode/i);
  });

  it("rejects a relative path", async () => {
    await expect(KeyringProvider.load("keyring.json")).rejects.toThrow(/absolute/i);
  });

  it("follows a symlink to a 0600 file and checks the opened target", async () => {
    const directoryPath = fixtureDirectory();
    const target = writeFixtureFile(directoryPath, "keyring.json", keyringJson());
    const link = join(directoryPath, "keyring-link.json");
    symlinkSync(target, link);

    const provider = await KeyringProvider.load(link);

    expect(provider.status().loaded).toBe(true);
    provider.destroy();
  });

  it("rejects malformed contents without exposing key bytes", async () => {
    const directoryPath = fixtureDirectory();
    const path = writeFixtureFile(directoryPath, "keyring.json", "{not json");

    await expect(KeyringProvider.load(path)).rejects.toThrow(/json|keyring/i);
  });
});

describe("provider serialization and inspection", () => {
  it("serializes only status fields", async () => {
    const directoryPath = fixtureDirectory();
    const path = writeFixtureFile(directoryPath, "keyring.json", keyringJson());

    const provider = await KeyringProvider.load(path);
    const serialized = JSON.stringify(provider);
    const printed = inspect(provider);

    expect(JSON.parse(serialized)).toEqual({ loaded: true, currentId: "k1", keyCount: 2 });
    expect(serialized).not.toContain(Buffer.alloc(32, 1).toString("base64"));
    expect(serialized).not.toContain("k2");
    expect(printed).toBe("KeyringProvider(loaded=true, current=k1, keys=2)");
    expect(printed).not.toContain(Buffer.alloc(32, 1).toString("base64"));
    expect(inspect(provider, { customInspect: false })).not.toContain(
      Buffer.alloc(32, 1).toString("base64"),
    );
    expect(JSON.stringify(structuredClone(provider))).not.toContain(
      Buffer.alloc(32, 1).toString("base64"),
    );

    provider.destroy();
  });
});

describe("provider disposal", () => {
  it("reports an unloaded status after destroy", async () => {
    const directoryPath = fixtureDirectory();
    const path = writeFixtureFile(directoryPath, "keyring.json", keyringJson());

    const provider = await KeyringProvider.load(path);
    provider.destroy();
    provider.destroy();

    expect(provider.status()).toEqual({ loaded: false, keyCount: 0 });
    expect(JSON.stringify(provider)).not.toContain("k1");
  });
});
