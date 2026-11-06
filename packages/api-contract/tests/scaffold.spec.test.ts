import { describe, expect, it } from "vitest";
import {
  agentConsumerStateReportSchema,
  agentConsumerStateSchema,
  scaffoldRequestSchema,
  scaffoldResponseSchema,
} from "../src/index.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TIMESTAMP = "2026-11-05T10:00:00.000Z";

describe("scaffold contracts", () => {
  it("should accept a valid request and default empty entries", () => {
    expect(scaffoldRequestSchema.parse({ project: "payments", service: "api" })).toEqual({
      project: "payments",
      service: "api",
      entries: [],
    });
  });

  it("should reject duplicate entries, bad service slugs, and unknown fields", () => {
    expect(
      scaffoldRequestSchema.safeParse({
        project: "payments",
        service: "api",
        entries: ["db-password", "db-password"],
      }).success,
    ).toBe(false);
    expect(
      scaffoldRequestSchema.safeParse({ project: "payments", service: "API", entries: [] }).success,
    ).toBe(false);
    expect(
      scaffoldRequestSchema.safeParse({ project: "payments", service: "api", extra: true }).success,
    ).toBe(false);
  });

  it("should accept a complete scaffold response", () => {
    const assignment = {
      id: ULID,
      principalId: ULID,
      role: "secrets.reader" as const,
      scopeType: "object" as const,
      scopeId: ULID,
      grantedBy: ULID,
      createdAt: TIMESTAMP,
      expiresAt: null,
    };
    expect(
      scaffoldResponseSchema.parse({
        project: {
          id: ULID,
          name: "payments",
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
          deletedAt: null,
        },
        identity: {
          id: ULID,
          name: "api",
          projectId: ULID,
          status: "active",
          createdAt: TIMESTAMP,
        },
        assignments: [{ name: "db-password", assignment }],
        joinToken: { id: ULID, token: "A".repeat(43), expiresAt: TIMESTAMP },
        compose: "services: {}",
        manifest: "project: payments",
        manifestFile: "openvault." + "$" + "{COMPOSE_PROJECT_NAME}.payments.api.manifest.yaml",
      }),
    ).toBeDefined();
  });

  it("should validate the heartbeat state and body", () => {
    expect(agentConsumerStateSchema.parse("degraded")).toBe("degraded");
    expect(agentConsumerStateReportSchema.parse({ state: "failed" })).toEqual({ state: "failed" });
    expect(agentConsumerStateReportSchema.safeParse({ state: "unknown" }).success).toBe(false);
    expect(agentConsumerStateReportSchema.safeParse({ state: "ok", extra: true }).success).toBe(
      false,
    );
  });
});
