import type { Logger } from "blendsdk/webafx";
import { describe, expect, it } from "vitest";
import {
  LoggingPolicyAudit,
  type PolicyDecisionEvent,
  type PolicyMutationEvent,
} from "../../src/rbac/audit.js";

interface LogLine {
  readonly message: string;
  readonly data: Record<string, unknown> | undefined;
}

function recordingLogger(lines: LogLine[], fail = false): Logger {
  const record = async (message: string, data?: Record<string, unknown>) => {
    if (fail) {
      throw new Error("logger unavailable");
    }
    lines.push({ message, data });
  };
  return {
    // Audit evidence must use the error channel; an info call is a test failure.
    info: async () => {
      throw new Error("audit must not use the info channel");
    },
    error: record,
    warn: async () => undefined,
    debug: async () => undefined,
  };
}

function decision(overrides: Partial<PolicyDecisionEvent> = {}): PolicyDecisionEvent {
  return {
    actorId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    actorKind: "user",
    action: "secret.read",
    scopeType: "project",
    scopeId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    objectType: "secret",
    objectId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    result: "allow",
    reason: "allowed",
    policyVersion: 4,
    ...overrides,
  };
}

function mutation(): PolicyMutationEvent {
  return {
    actorId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    actorKind: "user",
    action: "assignment.grant",
    assignmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    targetPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    role: "secrets.reader",
    scopeType: "project",
    scopeId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
    projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
    result: "allow",
    reason: "allowed",
    policyVersion: 4,
  };
}

describe("logging policy audit", () => {
  it("should log the decision fields and flatten request metadata", async () => {
    const lines: LogLine[] = [];
    const audit = new LoggingPolicyAudit(recordingLogger(lines));
    await audit.recordDecision(
      decision({
        context: {
          requestId: "request-1",
          sourceIp: "127.0.0.1",
          userAgent: "vitest",
        },
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe("policy decision");
    expect(lines[0]?.data).toMatchObject({
      actorId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      action: "secret.read",
      scopeType: "project",
      result: "allow",
      reason: "allowed",
      policyVersion: 4,
      requestId: "request-1",
      sourceIp: "127.0.0.1",
      userAgent: "vitest",
    });
    expect(lines[0]?.data).not.toHaveProperty("context");
    expect(lines[0]?.data).not.toHaveProperty("denialCount");
  });

  it("should increment the denial count per actor and keep actors separate", async () => {
    const lines: LogLine[] = [];
    const audit = new LoggingPolicyAudit(recordingLogger(lines));
    const actorA = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const actorB = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

    for (let index = 0; index < 3; index += 1) {
      await audit.recordDecision(
        decision({ actorId: actorA, result: "deny", reason: "no_assignment" }),
      );
    }
    await audit.recordDecision(
      decision({ actorId: actorB, result: "deny", reason: "no_assignment" }),
    );

    expect(lines.map((line) => line.data?.denialCount)).toEqual([1, 2, 3, 1]);
  });

  it("should bound the denial counter and reset an evicted actor", async () => {
    const lines: LogLine[] = [];
    const audit = new LoggingPolicyAudit(recordingLogger(lines));
    const first = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

    await audit.recordDecision(
      decision({ actorId: first, result: "deny", reason: "no_assignment" }),
    );
    for (let index = 0; index < 1_024; index += 1) {
      const actorId = `01ARZ3NDEKTSV4RRFFQ69G5X${index.toString(32).toUpperCase().padStart(2, "0")}`;
      await audit.recordDecision(decision({ actorId, result: "deny", reason: "no_assignment" }));
    }
    lines.length = 0;
    await audit.recordDecision(
      decision({ actorId: first, result: "deny", reason: "no_assignment" }),
    );

    expect(lines[0]?.data?.denialCount).toBe(1);
  });

  it("should log one mutation event without a denial count", async () => {
    const lines: LogLine[] = [];
    const audit = new LoggingPolicyAudit(recordingLogger(lines));
    await audit.recordMutation(mutation());

    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe("policy mutation");
    expect(lines[0]?.data).toMatchObject({
      action: "assignment.grant",
      actorKind: "user",
      role: "secrets.reader",
      scopeType: "project",
      policyVersion: 4,
    });
    expect(lines[0]?.data).not.toHaveProperty("denialCount");
  });

  it("should propagate a logger failure", async () => {
    const audit = new LoggingPolicyAudit(recordingLogger([], true));
    await expect(audit.recordDecision(decision())).rejects.toThrow("logger unavailable");
    await expect(audit.recordMutation(mutation())).rejects.toThrow("logger unavailable");
  });
});
