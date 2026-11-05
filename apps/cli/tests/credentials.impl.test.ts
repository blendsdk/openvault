import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthenticatedClient } from "../src/client/authenticated.js";
import { CredentialStore } from "../src/credentials/store.js";
import { HttpsAdapter } from "../src/transport/https-adapter.js";
import type { CliRuntime } from "../src/types.js";

const STORE_MODULE = fileURLToPath(new URL("../dist/credentials/store.js", import.meta.url));
const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openvault-cli-impl-"));
  directories.push(directory);
  return directory;
}

function storeFor(directory: string): CredentialStore {
  return new CredentialStore({
    env: { HOME: directory, XDG_CONFIG_HOME: join(directory, "config") },
  });
}

function runtimeFor(directory: string): CliRuntime {
  return {
    env: {},
    cwd: directory,
    stdout: () => undefined,
    stderr: () => undefined,
    stdin: Readable.from([]),
    isTty: false,
  };
}

function document(baseUrl: string): {
  version: 1;
  baseUrl: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
} {
  return {
    version: 1,
    baseUrl,
    accessToken: "access",
    refreshToken: "R".repeat(43),
    accessExpiresAt: "2026-11-05T12:15:00.000Z",
    refreshExpiresAt: "2026-11-06T00:00:00.000Z",
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("credential implementation edges", () => {
  it("should reclaim a corrupt lock after the stale window", async () => {
    const directory = tempDirectory();
    const store = storeFor(directory);
    store.save(document("https://vault.example.test"));
    writeFileSync(store.lockFile, "", { mode: 0o600 });
    const old = new Date(Date.now() - 120_000);
    utimesSync(store.lockFile, old, old);
    await expect(store.withLock(() => "ran")).resolves.toBe("ran");
    expect(existsSync(store.lockFile)).toBe(false);
  });

  it("should reclaim a lock with an invalid createdAt after the stale window", async () => {
    const directory = tempDirectory();
    const store = storeFor(directory);
    store.save(document("https://vault.example.test"));
    writeFileSync(
      store.lockFile,
      JSON.stringify({ pid: 2_147_483_647, createdAt: "not-a-date", owner: "dead" }),
      { mode: 0o600 },
    );
    const old = new Date(Date.now() - 120_000);
    utimesSync(store.lockFile, old, old);
    await expect(store.withLock(() => "ran")).resolves.toBe("ran");
    expect(existsSync(store.lockFile)).toBe(false);
  });

  it("should serialize two concurrent stale-lock reclaims", async () => {
    const directory = tempDirectory();
    const store = storeFor(directory);
    store.save(document("https://vault.example.test"));
    writeFileSync(
      store.lockFile,
      JSON.stringify({ pid: 2_147_483_647, createdAt: "not-a-date", owner: "dead" }),
      { mode: 0o600 },
    );
    const old = new Date(Date.now() - 120_000);
    utimesSync(store.lockFile, old, old);
    const events: string[] = [];
    await Promise.all([
      store.withLock(async () => {
        events.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 50));
        events.push("a-end");
      }),
      store.withLock(() => {
        events.push("b-start");
        events.push("b-end");
      }),
    ]);
    expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("should serialize two real processes through the credential lock", async () => {
    if (!existsSync(STORE_MODULE)) {
      return;
    }
    const directory = tempDirectory();
    const log = join(directory, "lock.log");
    const script = `
      import("${STORE_MODULE.replace(/\\/g, "\\\\")}").then(async ({ CredentialStore }) => {
        const { appendFileSync } = await import("node:fs");
        const { setTimeout: delay } = await import("node:timers/promises");
        const store = new CredentialStore({
          env: {
            HOME: ${JSON.stringify(directory)},
            XDG_CONFIG_HOME: ${JSON.stringify(join(directory, "config"))},
          },
        });
        await store.withLock(async () => {
          appendFileSync(${JSON.stringify(log)}, "start\\n");
          await delay(120);
          appendFileSync(${JSON.stringify(log)}, "end\\n");
        });
      });
    `;
    const run = async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`lock child exited ${code}`));
          }
        });
      });
    };
    await Promise.all([run(), run()]);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toEqual(["start", "end", "start", "end"]);
  });

  it("should refuse to use a token after the credential base URL changes", async () => {
    const directory = tempDirectory();
    const store = storeFor(directory);
    store.save(document("https://one.example.test"));
    const client = createAuthenticatedClient({
      credentials: store,
      transport: new HttpsAdapter({ baseUrl: "https://one.example.test" }),
      runtime: runtimeFor(directory),
    });
    store.save(document("https://two.example.test"));
    await expect(client.authHeaders()).rejects.toThrow(/different server/);
    await expect(client.client.auth.getCliMe()).rejects.toThrow(/different server/);
  });

  it("should keep the credential directory at 0700", () => {
    const directory = tempDirectory();
    const store = storeFor(directory);
    store.save(document("https://vault.example.test"));
    expect(statSync(store.directory).mode & 0o777).toBe(0o700);
  });
});
