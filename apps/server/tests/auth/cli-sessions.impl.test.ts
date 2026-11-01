import { describe, expect, it } from "vitest";
import { hashRefreshToken, normalizeUserAgent } from "../../src/auth/cli-sessions.js";

describe("CLI session helpers", () => {
  it("should trim and bound a user-agent value", () => {
    expect(normalizeUserAgent(undefined)).toBeNull();
    expect(normalizeUserAgent("   ")).toBeNull();
    expect(normalizeUserAgent("  ov/1.0  ")).toBe("ov/1.0");
    expect(normalizeUserAgent("a".repeat(600))).toHaveLength(512);
  });

  it("should hash the canonical token deterministically to 32 bytes", () => {
    const token = "A".repeat(43);
    const first = hashRefreshToken(token);
    const second = hashRefreshToken(token);

    expect(first).toHaveLength(32);
    expect(first.equals(second)).toBe(true);
    expect(hashRefreshToken("B".repeat(43)).equals(first)).toBe(false);
    expect(first.toString("utf8")).not.toContain(token);
  });
});
