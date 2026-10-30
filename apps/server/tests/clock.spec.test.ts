import { describe, expect, it } from "vitest";
import { CLOCK_SKEW_SECONDS, isWithinClockSkew } from "../src/security/clock.js";

const now = Date.parse("2026-01-01T12:00:00Z");
const toleranceMs = CLOCK_SKEW_SECONDS * 1_000;

describe("clock skew policy", () => {
  it("accepts exactly the 30-second boundary in both directions", () => {
    expect(isWithinClockSkew(now, now - toleranceMs, now + toleranceMs)).toBe(true);
    expect(isWithinClockSkew(now, now, now)).toBe(true);
  });

  it("rejects one millisecond beyond either boundary", () => {
    expect(isWithinClockSkew(now, now + toleranceMs, now + toleranceMs + 1_000)).toBe(true);
    expect(isWithinClockSkew(now, now + toleranceMs + 1, now + toleranceMs + 1_000)).toBe(false);
    expect(isWithinClockSkew(now, now - toleranceMs - 1_000, now - toleranceMs)).toBe(true);
    expect(isWithinClockSkew(now, now - toleranceMs - 1_000, now - toleranceMs - 1)).toBe(false);
  });

  it("accepts values inside the early and late windows", () => {
    expect(isWithinClockSkew(now, now - 1, now + 1)).toBe(true);
    expect(isWithinClockSkew(now, now + 10_000, now + 20_000)).toBe(true);
    expect(isWithinClockSkew(now, now - 20_000, now - 10_000)).toBe(true);
  });
});
