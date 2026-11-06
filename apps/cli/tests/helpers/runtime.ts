import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { runCli } from "../../src/cli.js";
import type { CliRuntime } from "../../src/types.js";
import type { FakeVault } from "./fake-vault.js";

/** One CLI test environment. */
export interface TestRuntime {
  readonly runtime: CliRuntime;
  readonly directory: string;
  readonly env: NodeJS.ProcessEnv;
  run(
    args: readonly string[],
    input?: string,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  credentialPath(): string;
  cleanup(): void;
}

/** Creates one isolated CLI runtime. */
export function createTestRuntime(
  vault: FakeVault,
  overrides: Pick<
    Partial<CliRuntime>,
    "runInit" | "runBackup" | "runRestore" | "runKekRotate" | "runCheckpointExport"
  > = {},
): TestRuntime {
  const directory = mkdtempSync(join(tmpdir(), "openvault-cli-test-"));
  const env: NodeJS.ProcessEnv = {
    HOME: directory,
    XDG_CONFIG_HOME: join(directory, "config"),
    OPENVAULT_CA_FILE: vault.caPath,
    OPENVAULT_URL: vault.url.href,
    PATH: process.env.PATH ?? "",
  };
  const runtime: CliRuntime = {
    env,
    cwd: directory,
    stdout: () => undefined,
    stderr: () => undefined,
    stdin: Readable.from([]),
    isTty: false,
    now: Date.now,
    ...overrides,
  };
  return {
    runtime,
    directory,
    env,
    async run(args, input) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const stdin = input === undefined ? Readable.from([]) : Readable.from([input]);
      const runtimeForRun: CliRuntime = {
        ...runtime,
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
        stdin,
      };
      const code = await runCli(args, runtimeForRun);
      return { code, stdout: stdout.join(""), stderr: stderr.join("") };
    },
    credentialPath(): string {
      return join(directory, "config", "openvault", "credentials.json");
    },
    cleanup(): void {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Reads the saved credential file. */
export function readCredentials(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
