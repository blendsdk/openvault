import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import type { CliRuntime } from "../src/types.js";

const directories: string[] = [];

function runtime(): {
  runtime: CliRuntime;
  run: (
    args: string[],
    input?: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  cleanup: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "openvault-cli-dispatch-"));
  directories.push(directory);
  const base: CliRuntime = {
    env: { HOME: directory, XDG_CONFIG_HOME: join(directory, "config") },
    cwd: directory,
    stdout: () => undefined,
    stderr: () => undefined,
    stdin: Readable.from([]),
    isTty: false,
  };
  return {
    runtime: base,
    async run(args, input) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(args, {
        ...base,
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
        stdin: input === undefined ? Readable.from([]) : Readable.from([input]),
      });
      return { code, stdout: stdout.join(""), stderr: stderr.join("") };
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CLI dispatcher", () => {
  it("should list every group and command in root help", async () => {
    const harness = runtime();
    const result = await harness.run(["--help"]);
    expect(result.code).toBe(0);
    for (const group of [
      "auth",
      "project",
      "secret",
      "cert",
      "identity",
      "role",
      "access",
      "audit",
      "docker",
      "run",
      "init",
      "backup",
      "restore",
      "kek",
      "doctor",
      "completion",
    ]) {
      expect(result.stdout).toContain(group);
    }
    expect(result.stdout).toContain("backup");
    expect(result.stdout).not.toContain("RD-13");
  });

  it("should print the version", async () => {
    const harness = runtime();
    const result = await harness.run(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("1.0.1");
  });

  it("should print root help and exit 2 for an unknown group", async () => {
    const harness = runtime();
    const result = await harness.run(["unknown"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown group");
  });

  it("should print multi-command group help", async () => {
    const harness = runtime();
    const result = await harness.run(["secret", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("set");
    expect(result.stdout).toContain("versions");
  });

  it("should execute a single-command group and validate its environment", async () => {
    const harness = runtime();
    const result = await harness.run(["backup", "--out", "/tmp/backup.age"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("OPENVAULT_DB_URL");
  });

  it("should reject an unknown top-level option in JSON mode", async () => {
    const harness = runtime();
    const result = await harness.run(["--json", "--bad"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      success: false,
      error: { code: "usage_error" },
    });
  });

  it("should not print help on stdout for an unknown group in JSON mode", async () => {
    const harness = runtime();
    const result = await harness.run(["--json", "nope"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    const parsed = JSON.parse(result.stderr) as { success: boolean; error: { code: string } };
    expect(parsed).toMatchObject({ success: false, error: { code: "usage_error" } });
  });

  it("should send parser help and the validation issue to stderr in human mode", async () => {
    const harness = runtime();
    const result = await harness.run(["secret", "set", "--project", "payments", "--stdin"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Welcome to ov secret");
    expect(result.stderr).toContain("required");
  });

  it("should emit a JSON error when --json is set", async () => {
    const harness = runtime();
    const result = await harness.run(["--json", "backup"]);
    expect(result.code).toBe(2);
    const parsed = JSON.parse(result.stderr) as { success: boolean; error: { code: string } };
    expect(parsed.success).toBe(false);
    expect(parsed.error.code).toBe("usage_error");
  });

  it("should print completion for each shell", async () => {
    const harness = runtime();
    for (const shell of ["bash", "zsh", "fish"]) {
      const result = await harness.run(["completion", shell]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("ov");
    }
  });

  it("should require -- for run", async () => {
    const harness = runtime();
    const result = await harness.run(["run"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: ov run");
  });

  it("should fail before starting a child when the run manifest is missing", async () => {
    const harness = runtime();
    const result = await harness.run(["run", "--", process.execPath, "-e", "process.exit(0)"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("manifest");
  });

  it("should reject an invalid global timeout", async () => {
    const harness = runtime();
    const result = await harness.run(["--timeout", "0", "doctor"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--timeout");
  });

  it("should reject a non-HTTPS login URL before reading credentials", async () => {
    const harness = runtime();
    const result = await harness.run(
      ["login", "--identifier", "ada", "--password-stdin", "--url", "http://vault.example.test"],
      "correct-horse",
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("HTTPS");
  });
});
