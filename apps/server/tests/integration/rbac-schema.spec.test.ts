import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PolicyUnavailableError } from "../../src/rbac/errors.js";
import { PolicyRepository } from "../../src/rbac/policy-repository.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
}, 30_000);

afterAll(async () => {
  await testDb?.cleanup();
});

describe("policy_state schema", () => {
  it("should create exactly one version row", async () => {
    const table = await testDb.db.executeQuery<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'policy_state'",
    );
    expect(table.records.map((row) => row.table_name)).toEqual(["policy_state"]);

    const rows = await testDb.db.executeQuery<{ id: number; version: string }>(
      "SELECT id, version FROM policy_state",
    );
    expect(rows.records).toHaveLength(1);
    expect(rows.records[0]?.id).toBe(1);
    expect(Number(rows.records[0]?.version)).toBe(1);
  });

  it("should reject a second row, a changed id, and a non-positive version", async () => {
    await expect(
      testDb.db.executeQuery("INSERT INTO policy_state (id, version) VALUES (2, 1)"),
    ).rejects.toThrow();

    await expect(
      testDb.db.executeQuery("UPDATE policy_state SET id = 2 WHERE id = 1"),
    ).rejects.toThrow();

    await expect(
      testDb.db.executeQuery("UPDATE policy_state SET version = 0 WHERE id = 1"),
    ).rejects.toThrow();
  });

  it("should include the table in generated types and CType constants", () => {
    const types = readFileSync(
      new URL("../../src/database/generated-types.ts", import.meta.url),
      "utf8",
    );
    const constants = readFileSync(
      new URL("../../src/database/ctypes.ts", import.meta.url),
      "utf8",
    );
    expect(types).toContain("export interface PolicyState");
    expect(types).toContain("version");
    expect(constants).toContain("policy_state");
  });
});

describe("policy version reads", () => {
  it("should return the current version", async () => {
    const repository = new PolicyRepository(testDb.db);
    await expect(repository.readPolicyVersion()).resolves.toBe(1);
  });

  it("should fail closed when the version row is missing", async () => {
    await testDb.db.executeQuery("DELETE FROM policy_state");
    const repository = new PolicyRepository(testDb.db);
    await expect(repository.readPolicyVersion()).rejects.toBeInstanceOf(PolicyUnavailableError);
    await testDb.db.executeQuery("INSERT INTO policy_state (id, version) VALUES (1, 1)");
  });
});
