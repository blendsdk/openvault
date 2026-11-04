import { describe, expect, it } from "vitest";
import {
  type ConsumerRecord,
  classifyConsumerChange,
} from "../../src/agent/consumer-repository.js";

function consumer(overrides: Partial<ConsumerRecord> = {}): ConsumerRecord {
  return {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    composeProject: "compose",
    composeService: "api",
    hostname: "host",
    manifestHash: `sha256:${"a".repeat(64)}`,
    state: "ok",
    firstSeen: new Date("2026-01-01T00:00:00.000Z"),
    lastSeen: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("consumer change detection", () => {
  it("should register when no previous row exists", () => {
    expect(classifyConsumerChange(undefined, consumer())).toEqual({ kind: "register" });
  });

  it("should report changed metadata in fixed order", () => {
    const previous = consumer();
    const next = consumer({
      composeService: "worker",
      hostname: "other",
      state: "degraded",
    });
    expect(classifyConsumerChange(previous, next)).toEqual({
      kind: "update",
      changed: ["composeService", "hostname", "state"],
    });
  });

  it("should ignore a last_seen-only update", () => {
    const previous = consumer();
    const next = consumer({ lastSeen: new Date("2026-01-02T00:00:00.000Z") });
    expect(classifyConsumerChange(previous, next)).toBeNull();
  });
});
