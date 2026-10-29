import { describe, expect, it } from "vitest";
import { SENTINEL_KEY, SENTINEL_VALUE } from "../src/index.js";

describe("test sentinels", () => {
  it("should expose stable, recognizable sentinel values", () => {
    expect(SENTINEL_VALUE).toBe("SENTINEL_DO_NOT_LEAK_7f3a");
    expect(SENTINEL_KEY).toBe("SENTINEL_KEY_DO_NOT_LEAK_7f3a");
    expect(SENTINEL_VALUE.length).toBeGreaterThan(0);
    expect(SENTINEL_KEY.length).toBeGreaterThan(0);
  });
});
