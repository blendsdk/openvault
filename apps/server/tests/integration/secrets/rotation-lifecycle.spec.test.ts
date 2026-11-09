import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createTestDatabase,
  type TestDatabase,
} from "../helpers/test-database.js";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
}, 60_000);

afterAll(async () => {
  await testDb.cleanup();
});

describe("rotation notification lifecycle schema", () => {
  it("should create the notification table with its dedupe and foreign-key constraints", async () => {
    const table = await testDb.db.executeQuery<{ readonly table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'secret_rotation_notifications'`,
    );
    expect(table.records).toEqual([{ table_name: "secret_rotation_notifications" }]);

    const constraints = await testDb.db.executeQuery<{ readonly conname: string }>(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'secret_rotation_notifications'::regclass
        ORDER BY conname`,
    );
    const names = constraints.records.map((row) => row.conname);
    expect(names).toEqual(
      expect.arrayContaining([
        "secret_rotation_notifications_secret_id_version_id_s_55f86645f5",
        expect.stringContaining("audit_event_id"),
        expect.stringContaining("fkey"),
      ]),
    );
  });

  it("should include the table in the logical dump table set", async () => {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: testDb.url });
    await client.connect();
    try {
      const { listDataTables } = await import("../../../src/ops/database-dump.js");
      const tables = await listDataTables(client);
      expect(tables).toContain("secret_rotation_notifications");
    } finally {
      await client.end();
    }
  });
});
