import { describe, expect, it } from "vitest";
import { validateDetails } from "../../src/audit/actions.js";
import { AuditInputError } from "../../src/audit/errors.js";

describe("audit detail bounds", () => {
  it("should reject a details object above 16 KiB", () => {
    const changed = Array.from({ length: 17 }, () => "x".repeat(1_024));
    expect(() => validateDetails("consumer.update", { changed })).toThrow(AuditInputError);
  });

  it("should reject a null character in a detail", () => {
    expect(() => validateDetails("auth.login", { reason: "a\u0000b" })).toThrow(AuditInputError);
  });

  it("should accept a filters object with primitive values", () => {
    expect(() =>
      validateDetails("audit.export", {
        format: "ndjson",
        filters: { action: "project.read", from: "2026-01-01T00:00:00.000Z" },
      }),
    ).not.toThrow();
  });
});
