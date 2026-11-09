import { readFileSync, statSync } from "node:fs";
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
  return runtime;
}

async function createSecret(runtime: TestRuntime, name = "db-password"): Promise<void> {
  const result = await runtime.run(
    ["secret", "set", name, "--project", "payments", "--stdin"],
    "initial-value",
  );
  expect(result.code).toBe(0);
}

beforeAll(async () => {
  vault = await startFakeVault();
});

afterAll(async () => {
  await vault.close();
});

describe("ov rotation", () => {
  it("should set and clear a rotation policy", async () => {
    const runtime = await runtimeForTest();
    try {
      await createSecret(runtime);
      const set = await runtime.run([
        "rotation",
        "set",
        "db-password",
        "--every-days",
        "30",
        "--project",
        "payments",
      ]);
      expect(set.code).toBe(0);
      expect(set.stdout).toContain("30");
      const patch = vault.requests.find(
        (request) => request.method === "PATCH" && request.path.endsWith("/secrets/db-password"),
      );
      expect(patch?.body).toMatchObject({ rotationIntervalDays: 30 });

      const clear = await runtime.run([
        "rotation",
        "clear",
        "db-password",
        "--project",
        "payments",
      ]);
      expect(clear.code).toBe(0);
      const clearPatch = vault.requests.filter((request) => request.method === "PATCH").at(-1);
      expect(clearPatch?.body).toMatchObject({ rotationIntervalDays: null });
    } finally {
      runtime.cleanup();
    }
  });

  it("should list due secrets and show the policy status", async () => {
    const runtime = await runtimeForTest();
    try {
      await createSecret(runtime);
      await runtime.run([
        "rotation",
        "set",
        "db-password",
        "--every-days",
        "1",
        "--project",
        "payments",
      ]);
      const list = await runtime.run([
        "rotation",
        "list",
        "--due",
        "--project",
        "payments",
        "--json",
      ]);
      expect(list.code).toBe(0);
      expect(
        vault.requests.some(
          (request) =>
            request.method === "GET" &&
            request.path.endsWith("/secrets") &&
            request.query.includes("rotation=due"),
        ),
      ).toBe(true);
      expect(JSON.parse(list.stdout).data.secrets).toHaveLength(1);

      const status = await runtime.run([
        "rotation",
        "status",
        "db-password",
        "--project",
        "payments",
      ]);
      expect(status.code).toBe(0);
      expect(status.stdout).toContain("every 1 day");
      expect(status.stdout).toContain("db-password");
    } finally {
      runtime.cleanup();
    }
  });

  it("should rotate from stdin and send the value and expiry", async () => {
    const runtime = await runtimeForTest();
    try {
      await createSecret(runtime);
      const result = await runtime.run(
        [
          "rotation",
          "rotate",
          "db-password",
          "--stdin",
          "--expires-at",
          "2027-01-01T00:00:00.000Z",
          "--project",
          "payments",
        ],
        "rotated-value",
      );
      expect(result.code).toBe(0);
      const put = vault.requests
        .filter(
          (request) => request.method === "PUT" && request.path.endsWith("/secrets/db-password"),
        )
        .at(-1);
      expect(put?.body).toMatchObject({
        value: "rotated-value",
        expiresAt: "2027-01-01T00:00:00.000Z",
      });
      expect(result.stdout).not.toContain("rotated-value");
    } finally {
      runtime.cleanup();
    }
  });

  it("should write a generated value to a mode-0600 file", async () => {
    const runtime = await runtimeForTest();
    try {
      await createSecret(runtime);
      const out = join(runtime.directory, "generated.txt");
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
      expect(result.code).toBe(0);
      const value = readFileSync(out, "utf8");
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(statSync(out).mode & 0o777).toBe(0o600);
      expect(result.stdout).not.toContain(value);
      const put = vault.requests
        .filter(
          (request) => request.method === "PUT" && request.path.endsWith("/secrets/db-password"),
        )
        .at(-1);
      expect(put?.body).toMatchObject({ value });
    } finally {
      runtime.cleanup();
    }
  });

  it("should print a generated value once when no output file is given", async () => {
    const runtime = await runtimeForTest();
    try {
      await createSecret(runtime);
      const result = await runtime.run([
        "rotation",
        "rotate",
        "db-password",
        "--generate",
        "--project",
        "payments",
      ]);
      expect(result.code).toBe(0);
      const match = /([A-Za-z0-9_-]{43})/.exec(result.stdout);
      expect(match).not.toBeNull();
      expect(result.stderr).toContain("will not be shown again");
    } finally {
      runtime.cleanup();
    }
  });

  it("should reject invalid option combinations", async () => {
    const runtime = await runtimeForTest();
    try {
      await createSecret(runtime);
      const generatedWithStdin = await runtime.run(
        ["rotation", "rotate", "db-password", "--generate", "--stdin", "--project", "payments"],
        "value",
      );
      expect(generatedWithStdin.code).toBe(2);
      const outWithoutGenerate = await runtime.run([
        "rotation",
        "rotate",
        "db-password",
        "--out",
        join(runtime.directory, "x"),
        "--project",
        "payments",
      ]);
      expect(outWithoutGenerate.code).toBe(2);
      const bothFilters = await runtime.run([
        "rotation",
        "list",
        "--due",
        "--overdue",
        "--project",
        "payments",
      ]);
      expect(bothFilters.code).toBe(2);
    } finally {
      runtime.cleanup();
    }
  });

  it("should keep a generated value out of JSON metadata", async () => {
    const runtime = await runtimeForTest();
    try {
      await createSecret(runtime);
      const out = join(runtime.directory, "generated-json.txt");
      const result = await runtime.run([
        "rotation",
        "rotate",
        "db-password",
        "--generate",
        "--out",
        out,
        "--json",
        "--project",
        "payments",
      ]);
      expect(result.code).toBe(0);
      const value = readFileSync(out, "utf8");
      const parsed = JSON.parse(result.stdout) as { data: Record<string, unknown> };
      expect(JSON.stringify(parsed)).not.toContain(value);
    } finally {
      runtime.cleanup();
    }
  });
});
