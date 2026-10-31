import { argon2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ARGON2_MEMORY_KIB,
  ARGON2_PARALLELISM,
  ARGON2_PASSES,
  ARGON2_SALT_BYTES,
  ARGON2_TAG_LENGTH,
  hashPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validateNewPassword,
  verifyPassword,
} from "../../src/auth/password.js";

const PASSWORD = "correct horse battery staple";

/** The salt and tag bytes decoded from one PHC string. */
interface ParsedPhc {
  readonly salt: Buffer;
  readonly tag: Buffer;
}

/**
 * Parses the password hash format and decodes its binary fields.
 *
 * The decoder accepts both the standard and the URL-safe base64 alphabet
 * because Node's base64 decoder tolerates either. The pattern deliberately
 * rejects padding, unreachable parameters, and any other algorithm.
 *
 * @param phc - Stored password hash string.
 * @returns Decoded salt and tag.
 * @throws {Error} When the string is not a policy-compliant Argon2id hash.
 */
function parsePhc(phc: string): ParsedPhc {
  const match = /^\$argon2id\$v=19\$m=65536,t=3,p=1\$([A-Za-z0-9+/_-]+)\$([A-Za-z0-9+/_-]+)$/.exec(
    phc,
  );
  const saltText = match?.[1];
  const tagText = match?.[2];
  if (saltText === undefined || tagText === undefined) {
    throw new Error(`unexpected password hash format: ${phc}`);
  }
  return {
    salt: Buffer.from(saltText, "base64"),
    tag: Buffer.from(tagText, "base64"),
  };
}

/**
 * Derives a reference tag with the fixed cost policy.
 *
 * The production hashing code must produce the same tag for the same password
 * and salt; this derivation is the independent oracle for that claim.
 *
 * @param password - Password to derive.
 * @param salt - Salt bytes read from a stored hash.
 * @returns The derived tag.
 */
function referenceTag(password: string, salt: Buffer): Buffer {
  return argon2Sync("argon2id", {
    message: Buffer.from(password, "utf8"),
    nonce: salt,
    memory: 65_536,
    passes: 3,
    parallelism: 1,
    tagLength: 32,
  });
}

describe("password hash format", () => {
  it("should produce a verifiable Argon2id hash with the fixed cost policy when a password is hashed", async () => {
    const phc = await hashPassword(PASSWORD);
    const parsed = parsePhc(phc);

    expect(phc.startsWith("$argon2id$v=19$m=65536,t=3,p=1$")).toBe(true);
    expect(parsed.salt).toHaveLength(16);
    expect(parsed.tag).toHaveLength(32);
    expect(parsed.tag).toEqual(referenceTag(PASSWORD, parsed.salt));
    await expect(verifyPassword(PASSWORD, phc)).resolves.toBe(true);
  });

  it("should generate a fresh salt and tag when the same password is hashed twice", async () => {
    const first = parsePhc(await hashPassword(PASSWORD));
    const second = parsePhc(await hashPassword(PASSWORD));

    expect(first.salt).not.toEqual(second.salt);
    expect(first.tag).not.toEqual(second.tag);
  });

  it("should reject a wrong password while accepting the exact stored password", async () => {
    const phc = await hashPassword(PASSWORD);

    await expect(verifyPassword(`${PASSWORD}!`, phc)).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD.toUpperCase(), phc)).resolves.toBe(false);
    await expect(verifyPassword(`${PASSWORD} `, phc)).resolves.toBe(false);
    await expect(verifyPassword("", phc)).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, phc)).resolves.toBe(true);
  });
});

describe("password policy", () => {
  it("should expose the fixed Argon2id cost and length policy", () => {
    expect(ARGON2_MEMORY_KIB).toBe(65_536);
    expect(ARGON2_PASSES).toBe(3);
    expect(ARGON2_PARALLELISM).toBe(1);
    expect(ARGON2_TAG_LENGTH).toBe(32);
    expect(ARGON2_SALT_BYTES).toBe(16);
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(1024);
  });

  it("should reject a stored hash with a weaker memory cost or a different parallelism", async () => {
    const phc = await hashPassword(PASSWORD);
    const weakerMemory = phc.replace("m=65536", "m=32768");
    const sharedLanes = phc.replace(",p=1", ",p=2");

    expect(weakerMemory).not.toBe(phc);
    expect(sharedLanes).not.toBe(phc);
    await expect(verifyPassword(PASSWORD, weakerMemory)).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, sharedLanes)).resolves.toBe(false);
  });

  it("should reject malformed and non-Argon2id hashes without throwing", async () => {
    const phc = await hashPassword(PASSWORD);
    const malformed = [
      "",
      "not-a-hash",
      "$argon2i$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "$argon2id$v=16$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      phc.replace("$argon2id$", "$argon2idx$"),
      phc.replace("m=65536", "m=65537"),
      phc.replace(",t=3", ",t=4"),
      `${phc}$extra`,
    ];

    for (const candidate of malformed) {
      await expect(verifyPassword(PASSWORD, candidate)).resolves.toBe(false);
    }
  });

  it("should enforce the length policy without trimming or requiring character classes", () => {
    expect(() => validateNewPassword("a".repeat(PASSWORD_MIN_LENGTH - 1))).toThrow();
    expect(() => validateNewPassword("a".repeat(PASSWORD_MIN_LENGTH))).not.toThrow();
    expect(() => validateNewPassword("a".repeat(PASSWORD_MAX_LENGTH))).not.toThrow();
    expect(() => validateNewPassword("a".repeat(PASSWORD_MAX_LENGTH + 1))).toThrow();
    expect(() => validateNewPassword("")).toThrow();
    expect(() => validateNewPassword(" ".repeat(PASSWORD_MIN_LENGTH))).not.toThrow();
    expect(() => validateNewPassword("  abcdefghij  ")).not.toThrow();
  });
});
