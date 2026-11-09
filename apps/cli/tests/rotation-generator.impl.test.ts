import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeVault, startFakeVault } from "./helpers/fake-vault.js";
import { createTestRuntime, type TestRuntime } from "./helpers/runtime.js";

let vault: FakeVault;

async function runtimeForTest(): Promise<TestRuntime> {
  const runtime = createTestRuntime(vault);
  const login = await runtime.run(
    ["login", "--identifier", "ada", "--password-stdin", "--url", vault.url.href],
    "correct-horse\n",
  );
  expect(login.code).toBe(0);
  await runtime.run(
    ["secret", "set", "db-password", "--project", "payments", "--stdin"],
    "initial-value",
  );
  return runtime;
}

beforeAll(async () => {
  vault = await startFakeVault();
});

afterAll(async () => {
  await vault.close();
});

describe("rotation generator implementation", () => {
  it("should replace an output file only with --force", async () => {
    const runtime = await runtimeForTest();
    try {
      const out = join(runtime.directory, "existing.txt");
      writeFileSync(out, "old", { mode: 0o600 });
      const withoutForce = await runtime.run([
        "rotation",
        "rotate",
        "db-password",
        "--generate",
        "--out",
        out,
        "--project",
        "payments",
      ]);
      expect(withoutForce.code).toBe(2);
      expect(readFileSync(out, "utf8")).toBe("old");
      const withForce = await runtime.run([
        "rotation",
        "rotate",
        "db-password",
        "--generate",
        "--out",
        out,
        "--force",
        "--project",
        "payments",
      ]);
      expect(withForce.code).toBe(0);
      expect(readFileSync(out, "utf8")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(statSync(out).mode & 0o777).toBe(0o600);
    } finally {
      runtime.cleanup();
    }
  });

  it("should remove the new file when the server write fails", async () => {
    const runtime = await runtimeForTest();
    try {
      const out = join(runtime.directory, "failed.txt");
      vault.failNextSecretWrite = true;
      const result = await runtime.run([
        "rotation",
        "rotate",
        "db-password",
        "--generate",
        "--out",
        out,
        "--project",
        "payments",
      ]);
      expect(result.code).toBe(1);
      expect(existsSync(out)).toBe(false);
    } finally {
      runtime.cleanup();
    }
  });
});
