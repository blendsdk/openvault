import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sameCredentialOrigin } from "../src/client/authenticated.js";
import { checkBackupAge } from "../src/commands/doctor.js";

const directories: string[] = [];

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "openvault-doctor-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("credential origin binding", () => {
  it("accepts the same scheme, host, and port, including default ports and paths", () => {
    expect(sameCredentialOrigin("https://vault.example", "https://vault.example:443")).toBe(true);
    expect(sameCredentialOrigin("https://vault.example/a", "https://vault.example/b")).toBe(true);
    expect(sameCredentialOrigin("https://vault.example:8443", "https://vault.example:8443")).toBe(
      true,
    );
  });

  it("rejects scheme, host, port, and invalid URL differences", () => {
    expect(sameCredentialOrigin("https://vault.example", "http://vault.example")).toBe(false);
    expect(sameCredentialOrigin("https://vault.example", "https://other.example")).toBe(false);
    expect(sameCredentialOrigin("https://vault.example", "https://vault.example:8443")).toBe(false);
    expect(sameCredentialOrigin("not a url", "https://vault.example")).toBe(false);
    expect(sameCredentialOrigin("file:///tmp/vault", "file:///tmp/vault")).toBe(false);
  });
});

describe("doctor backup age", () => {
  it("accepts an archive inside the 24-hour RPO", () => {
    const path = directory();
    const archive = join(path, "openvault.age");
    writeFileSync(archive, "ciphertext");
    const now = Date.now();
    utimesSync(archive, new Date(now - 3_600_000), new Date(now - 3_600_000));

    expect(checkBackupAge(path, now)).toEqual({
      ok: true,
      detail: "newest backup is 1h old",
    });
  });

  it("rejects a stale archive", () => {
    const path = directory();
    const archive = join(path, "openvault.age");
    writeFileSync(archive, "ciphertext");
    const now = Date.now();
    utimesSync(archive, new Date(now - 25 * 3_600_000), new Date(now - 25 * 3_600_000));

    const result = checkBackupAge(path, now);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("RPO 24h");
  });

  it("rejects a missing directory and an empty directory", () => {
    expect(checkBackupAge(join(tmpdir(), "openvault-missing-doctor"), Date.now()).ok).toBe(false);
    expect(checkBackupAge(directory(), Date.now()).detail).toContain("no .age");
  });
});
