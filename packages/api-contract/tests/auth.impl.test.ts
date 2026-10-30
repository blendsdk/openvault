import { describe, expect, it } from "vitest";
import {
  authUserSchema,
  loginRequestSchema,
  passwordChangeRequestSchema,
  sessionEntrySchema,
  sessionListSchema,
  sessionResponseSchema,
} from "../src/index.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TIMESTAMP = "2026-10-30T12:00:00.000Z";

describe("auth schema implementation edges", () => {
  it("should reject null and non-object inputs", () => {
    for (const schema of [
      authUserSchema,
      loginRequestSchema,
      passwordChangeRequestSchema,
      sessionEntrySchema,
      sessionListSchema,
      sessionResponseSchema,
    ]) {
      for (const value of [null, undefined, "text", 42, [], true]) {
        expect(schema.safeParse(value).success).toBe(false);
      }
    }
  });

  it("should reject a non-UTC-offset-free timestamp", () => {
    const entry = {
      id: ULID,
      createdAt: "2026-10-30T12:00:00",
      expiresAt: TIMESTAMP,
      authMethod: "local",
      current: true,
    };

    expect(sessionEntrySchema.safeParse(entry).success).toBe(false);
    expect(sessionEntrySchema.safeParse({ ...entry, createdAt: TIMESTAMP }).success).toBe(true);
  });

  it("should reject a login identifier that is only whitespace", () => {
    expect(loginRequestSchema.safeParse({ identifier: "\t \n", password: "x" }).success).toBe(
      false,
    );
  });

  it("should reject a login password that is only whitespace only when empty", () => {
    expect(loginRequestSchema.safeParse({ identifier: "alice", password: " " }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ identifier: "alice", password: "" }).success).toBe(false);
  });

  it("should reject an auth user with a 101-character name and accept 100", () => {
    const user = { id: ULID, name: "a".repeat(100), email: null, authMethod: "local" };
    expect(authUserSchema.safeParse(user).success).toBe(true);
    expect(authUserSchema.safeParse({ ...user, name: "a".repeat(101) }).success).toBe(false);
  });

  it("should keep the session list strict at the entry level", () => {
    const entry = {
      id: ULID,
      createdAt: TIMESTAMP,
      expiresAt: TIMESTAMP,
      authMethod: "oidc",
      current: false,
    };

    expect(sessionListSchema.safeParse({ sessions: [entry] }).success).toBe(true);
    expect(sessionListSchema.safeParse({ sessions: [{ ...entry, secret: "leak" }] }).success).toBe(
      false,
    );
  });
});
