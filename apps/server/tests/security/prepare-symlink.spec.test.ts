import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../../deploy/compose/prepare.sh", import.meta.url));

interface Fixture {
  readonly root: string;
  readonly data: string;
  readonly secrets: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "openvault-prepare-"));
  return { root, data: join(root, "data"), secrets: join(root, "secrets") };
}

function run(
  env: { readonly data: string; readonly secrets: string },
  args: string[] = [],
  extraEnv: NodeJS.ProcessEnv = {},
): void {
  execFileSync("sh", [SCRIPT, ...args], {
    env: {
      ...process.env,
      ...extraEnv,
      OPENVAULT_DATA_DIR: env.data,
      OPENVAULT_SECRETS_DIR: env.secrets,
    },
    stdio: "pipe",
  });
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("prepare.sh symlink safety", () => {
  it("should refuse a symlinked non-empty secret without changing the target", () => {
    const env = fixture();
    try {
      mkdirSync(env.secrets, { recursive: true });
      const target = join(env.root, "target");
      writeFileSync(target, "keep", { mode: 0o644 });
      symlinkSync(target, join(env.secrets, "postgres_password"));

      expect(() => run(env, ["--secrets-only"])).toThrow();
      expect(readFileSync(target, "utf8")).toBe("keep");
      expect(mode(target)).toBe(0o644);
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("should refuse a symlinked empty URL file", () => {
    const env = fixture();
    try {
      mkdirSync(env.secrets, { recursive: true });
      const target = join(env.root, "empty");
      writeFileSync(target, "", { mode: 0o644 });
      symlinkSync(target, join(env.secrets, "db_app_url"));

      expect(() => run(env, ["--secrets-only"])).toThrow();
      expect(readFileSync(target, "utf8")).toBe("");
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("should refuse a symlinked data directory", () => {
    const env = fixture();
    try {
      const real = join(env.root, "real-data");
      mkdirSync(real, { mode: 0o755 });
      symlinkSync(real, env.data);

      expect(() => run(env)).toThrow();
      expect(mode(real)).toBe(0o755);
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("should create every secret and URL and preserve them on a second run", () => {
    const env = fixture();
    try {
      run(env, ["--secrets-only"]);
      expect(mode(env.data)).toBe(0o700);
      expect(mode(env.secrets)).toBe(0o700);
      for (const name of [
        "postgres_password",
        "db_migrator_password",
        "db_app_password",
        "db_auth_password",
        "db_purger_password",
        "db_pruner_password",
      ]) {
        expect(mode(join(env.secrets, name)), name).toBe(0o444);
      }
      for (const [name, prefix] of [
        ["db_migrator_url", "postgres://openvault_migrator:"],
        ["db_app_url", "postgres://openvault_app:"],
        ["db_auth_url", "postgres://openvault_auth:"],
        ["db_purger_url", "postgres://openvault_purger:"],
      ] as const) {
        expect(readFileSync(join(env.secrets, name), "utf8"), name).toContain(prefix);
      }
      const before = readdirSync(env.secrets)
        .sort()
        .map((name) => [name, readFileSync(join(env.secrets, name), "utf8")]);
      run(env, ["--secrets-only"]);
      const after = readdirSync(env.secrets)
        .sort()
        .map((name) => [name, readFileSync(join(env.secrets, name), "utf8")]);
      expect(after).toEqual(before);
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("should reject trailing slashes, traversal, and a symlink-to-directory secret", () => {
    const env = fixture();
    try {
      mkdirSync(env.secrets, { recursive: true });
      mkdirSync(join(env.root, "directory-target"));
      symlinkSync(join(env.root, "directory-target"), join(env.secrets, "postgres_password"));
      expect(() => run({ ...env, data: `${env.data}/` }, ["--secrets-only"])).toThrow();
      expect(() =>
        run({ ...env, data: join(env.root, "a", "..", "data") }, ["--secrets-only"]),
      ).toThrow();
      expect(() => run(env, ["--secrets-only"])).toThrow();
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("should fail instead of writing empty secrets when entropy generation fails", () => {
    const env = fixture();
    try {
      const bin = join(env.root, "bin");
      mkdirSync(bin);
      const openssl = join(bin, "openssl");
      writeFileSync(openssl, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      chmodSync(openssl, 0o755);

      expect(() =>
        run(env, ["--secrets-only"], { PATH: `${bin}:${process.env.PATH ?? ""}` }),
      ).toThrow();
      expect(readdirSync(env.secrets)).toEqual([]);
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("should create the data subdirectories on a full run", () => {
    const env = fixture();
    try {
      run(env);
      for (const name of [
        "postgres",
        "openvault",
        "bootstrap",
        "tls",
        "ca",
        "caddy",
        "caddy/data",
        "caddy/config",
      ]) {
        expect(statSync(join(env.data, name)).isDirectory(), name).toBe(true);
      }
    } finally {
      rmSync(env.root, { recursive: true, force: true });
    }
  });
});
