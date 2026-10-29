import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defaultMigrationsDirectory,
  stripCommentsStringsAndDollarQuotes,
} from "../src/db/migrate.js";
import { DatabaseUrlError, parseDatabaseUrl } from "../src/db/url.js";

describe("parseDatabaseUrl", () => {
  it("should parse a complete PostgreSQL URL", () => {
    const config = parseDatabaseUrl("postgres://openvault:p%40ss@db.internal:5433/openvault");

    expect(config).toEqual({
      host: "db.internal",
      port: 5433,
      database: "openvault",
      user: "openvault",
      pass: "p@ss",
    });
  });

  it("should default to port 5432", () => {
    expect(parseDatabaseUrl("postgresql://user:pass@localhost/db").port).toBe(5432);
  });

  it("should reject malformed or incomplete URLs without echoing the password", () => {
    const cases = [
      "not-a-url",
      "mysql://user:pass@localhost/db",
      "postgres://user:pass@localhost/",
      "postgres://localhost/db",
      "postgres://user:pass@localhost:99999/db",
    ];

    for (const value of cases) {
      expect(() => parseDatabaseUrl(value)).toThrow(DatabaseUrlError);
      try {
        parseDatabaseUrl(value);
      } catch (error) {
        expect(String(error)).not.toContain("pass");
      }
    }
  });

  it("should resolve the shipped migration directory", () => {
    expect(existsSync(defaultMigrationsDirectory)).toBe(true);
  });
});

describe("stripCommentsStringsAndDollarQuotes", () => {
  it("should ignore transaction words in comments, strings, and dollar-quoted bodies", () => {
    const sql = `
      -- BEGIN;
      /* COMMIT; /* nested ROLLBACK; */ */
      SELECT 'BEGIN; COMMIT;';
      CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        RAISE NOTICE 'ROLLBACK;';
      END;
      $$;
    `;
    const stripped = stripCommentsStringsAndDollarQuotes(sql);

    expect(stripped).not.toMatch(/BEGIN|COMMIT|ROLLBACK/i);
    expect(stripped).toContain("SELECT");
    expect(stripped).toContain("CREATE FUNCTION");
  });

  it("should keep top-level transaction control visible", () => {
    expect(stripCommentsStringsAndDollarQuotes("BEGIN;\nSELECT 1;")).toMatch(/BEGIN;/);
    expect(stripCommentsStringsAndDollarQuotes("ROLLBACK;")).toMatch(/ROLLBACK;/);
  });

  it("should preserve newlines so line-anchored checks still work", () => {
    const stripped = stripCommentsStringsAndDollarQuotes("-- hidden\nBEGIN;");
    expect(stripped.split("\n")).toHaveLength(2);
  });
});
