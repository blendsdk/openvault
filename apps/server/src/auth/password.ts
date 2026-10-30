import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

/** Argon2id memory cost in 1 KiB blocks (64 MiB). */
export const ARGON2_MEMORY_KIB = 65_536;
/** Argon2id iteration count. */
export const ARGON2_PASSES = 3;
/** Argon2id lane count. */
export const ARGON2_PARALLELISM = 1;
/** Derived tag length in bytes. */
export const ARGON2_TAG_LENGTH = 32;
/** Salt length in bytes. */
export const ARGON2_SALT_BYTES = 16;
/** Minimum accepted local password length. */
export const PASSWORD_MIN_LENGTH = 12;
/** Maximum accepted local password length. */
export const PASSWORD_MAX_LENGTH = 1024;

const PHC_PATTERN = /^\$argon2id\$v=19\$m=65536,t=3,p=1\$([A-Za-z0-9+/_-]+)\$([A-Za-z0-9+/_-]+)$/;
const DUMMY_PHC =
  "$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** Raised when a candidate password is outside the accepted length range. */
export class PasswordPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PasswordPolicyError";
  }
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      {
        message: Buffer.from(password, "utf8"),
        nonce: salt,
        memory: ARGON2_MEMORY_KIB,
        passes: ARGON2_PASSES,
        parallelism: ARGON2_PARALLELISM,
        tagLength: ARGON2_TAG_LENGTH,
      },
      (error, derivedKey) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

/**
 * Hashes a password with the fixed Argon2id policy.
 *
 * The returned PHC string carries the salt and parameters, so verification
 * never depends on external metadata. Base64 padding is omitted.
 *
 * @param password - Plaintext password.
 * @returns A `$argon2id$` PHC string.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(ARGON2_SALT_BYTES);
  const tag = await derive(password, salt);
  return `$argon2id$v=19$m=65536,t=3,p=1$${salt.toString("base64").replace(/=+$/, "")}$${tag
    .toString("base64")
    .replace(/=+$/, "")}`;
}

/**
 * Verifies a password against a stored PHC hash.
 *
 * The parser accepts only the fixed Argon2id policy. Malformed, weaker, or
 * differently parameterized hashes return `false` without throwing.
 *
 * @param password - Plaintext password.
 * @param phc - Stored PHC string.
 * @returns True when the derived tag matches in constant time.
 */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  try {
    const match = PHC_PATTERN.exec(phc);
    const saltText = match?.[1];
    const tagText = match?.[2];
    if (saltText === undefined || tagText === undefined) {
      return false;
    }

    const salt = Buffer.from(saltText, "base64");
    const tag = Buffer.from(tagText, "base64");
    if (salt.length !== ARGON2_SALT_BYTES || tag.length !== ARGON2_TAG_LENGTH) {
      return false;
    }

    const derived = await derive(password, salt);
    return derived.length === tag.length && timingSafeEqual(derived, tag);
  } catch {
    return false;
  }
}

/**
 * Spends one full-cost Argon2id derivation and discards the result.
 *
 * Login uses this for unknown, disabled, and locked accounts so a rejection
 * does not reveal whether the account has a usable password.
 *
 * @param password - Candidate password.
 */
export async function dummyVerify(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_PHC);
}

/**
 * Enforces the new-password length policy.
 *
 * Passwords are never trimmed and no character-class rules are applied.
 *
 * @param password - Candidate new password.
 * @throws {PasswordPolicyError} When the length is outside 12–1024.
 */
export function validateNewPassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
}
