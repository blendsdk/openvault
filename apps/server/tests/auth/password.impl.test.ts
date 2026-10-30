import { describe, expect, it } from "vitest";
import {
  dummyVerify,
  hashPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validateNewPassword,
  verifyPassword,
} from "../../src/auth/password.js";

const PASSWORD = "correct horse battery staple";

function withSaltLength(phc: string, bytes: number): string {
  const parts = phc.split("$");
  parts[4] = Buffer.alloc(bytes, 1).toString("base64").replace(/=+$/, "");
  return parts.join("$");
}

function withTagLength(phc: string, bytes: number): string {
  const parts = phc.split("$");
  parts[5] = Buffer.alloc(bytes, 2).toString("base64").replace(/=+$/, "");
  return parts.join("$");
}

describe("password implementation edges", () => {
  it("should reject a salt or tag with the wrong decoded length", async () => {
    const phc = await hashPassword(PASSWORD);

    await expect(verifyPassword(PASSWORD, withSaltLength(phc, 15))).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, withSaltLength(phc, 17))).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, withTagLength(phc, 31))).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, withTagLength(phc, 33))).resolves.toBe(false);
  });

  it("should reject base64 padding in the stored fields", async () => {
    const phc = await hashPassword(PASSWORD);
    const padded = phc.replace(/\$([A-Za-z0-9+/]+)$/, "$1==");

    await expect(verifyPassword(PASSWORD, padded)).resolves.toBe(false);
  });

  it("should resolve dummy verification for arbitrary input", async () => {
    await expect(dummyVerify("")).resolves.toBeUndefined();
    await expect(dummyVerify(PASSWORD)).resolves.toBeUndefined();
  });

  it("should accept the exact policy boundaries and reject one character outside", () => {
    expect(() => validateNewPassword("a".repeat(PASSWORD_MIN_LENGTH))).not.toThrow();
    expect(() => validateNewPassword("a".repeat(PASSWORD_MAX_LENGTH))).not.toThrow();
    expect(() => validateNewPassword("a".repeat(PASSWORD_MIN_LENGTH - 1))).toThrow();
    expect(() => validateNewPassword("a".repeat(PASSWORD_MAX_LENGTH + 1))).toThrow();
  });
});
