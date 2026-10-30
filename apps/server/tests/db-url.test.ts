import { describe, expect, it } from "vitest";
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

  it("should fail closed when TLS is requested but unsupported", () => {
    expect(() => parseDatabaseUrl("postgres://user:pass@localhost/db?sslmode=require")).toThrow(
      DatabaseUrlError,
    );
    for (const value of ["true", "1", "on"]) {
      expect(() => parseDatabaseUrl(`postgres://user:pass@localhost/db?ssl=${value}`)).toThrow(
        DatabaseUrlError,
      );
    }
    expect(parseDatabaseUrl("postgres://user:pass@localhost/db?ssl=off").database).toBe("db");
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
});
