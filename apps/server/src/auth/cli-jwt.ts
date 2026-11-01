import { ulidSchema } from "@openvault/api-contract";
import { newUlid } from "@openvault/core";
import { decodeProtectedHeader, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { CLOCK_SKEW_SECONDS } from "../security/clock.js";

/** Issuer carried by every CLI access token. */
export const CLI_JWT_ISSUER = "openvault";
/** Audience carried by every CLI access token. */
export const CLI_JWT_AUDIENCE = "openvault-cli";
/** Access-token lifetime in seconds. */
export const CLI_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** The minimal claim set carried by a CLI access token. */
export interface CliAccessClaims {
  /** Token issuer. */
  readonly iss: typeof CLI_JWT_ISSUER;
  /** Token audience. */
  readonly aud: typeof CLI_JWT_AUDIENCE;
  /** Principal identifier. */
  readonly sub: string;
  /** CLI session family identifier. */
  readonly sid: string;
  /** Unique access-token identifier. */
  readonly jti: string;
  /** Issued-at time in seconds. */
  readonly iat: number;
  /** Expiry time in seconds. */
  readonly exp: number;
  /** Credential kind. */
  readonly kind: "user";
}

/** Resolves the public key for one JWT `kid`. */
export type CliKeyResolver = (kid: string) => Promise<CryptoKey | undefined>;

/** Inputs for signing one CLI access token. */
export interface SignCliAccessTokenInput {
  /** Current Ed25519 private key. */
  readonly privateKey: CryptoKey;
  /** Current key identifier. */
  readonly kid: string;
  /** Principal identifier. */
  readonly principalId: string;
  /** CLI session family identifier. */
  readonly familyId: string;
  /** Current time in milliseconds. */
  readonly nowMs: number;
}

/** Raised when a CLI access token is malformed or fails a required check. */
export class CliTokenError extends Error {
  public constructor(message = "Invalid CLI access token") {
    super(message);
    this.name = "CliTokenError";
  }
}

const claimsSchema = z.strictObject({
  iss: z.literal(CLI_JWT_ISSUER),
  aud: z.literal(CLI_JWT_AUDIENCE),
  sub: ulidSchema,
  sid: ulidSchema,
  jti: ulidSchema,
  iat: z.number().int(),
  exp: z.number().int(),
  kind: z.literal("user"),
});

/**
 * Signs one CLI access token.
 *
 * The token contains only the identity fields needed by the server. Roles,
 * permissions, names, and emails stay in the database and are never copied
 * into the credential.
 *
 * @param input - Principal, family, key, and current time.
 * @returns The compact JWT and its absolute expiry in milliseconds.
 */
export async function signCliAccessToken(
  input: SignCliAccessTokenInput,
): Promise<{ readonly token: string; readonly expiresAt: number }> {
  const issuedAt = Math.floor(input.nowMs / 1_000);
  const expiresAt = issuedAt + CLI_ACCESS_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({ sid: input.familyId, kind: "user" })
    .setProtectedHeader({ alg: "EdDSA", kid: input.kid })
    .setIssuer(CLI_JWT_ISSUER)
    .setAudience(CLI_JWT_AUDIENCE)
    .setSubject(input.principalId)
    .setJti(newUlid(input.nowMs))
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(input.privateKey);

  return { token, expiresAt: expiresAt * 1_000 };
}

/**
 * Verifies one CLI access token and returns its claims.
 *
 * Verification is deliberately strict: EdDSA is the only accepted algorithm,
 * the key id must be a ULID, the issuer and audience must match exactly, and
 * the payload must contain exactly the documented claims. The resolver is not
 * called for a malformed header or when the key is unknown.
 *
 * @param token - Compact JWT from the Authorization header.
 * @param resolveKey - Resolves the public key for the token's `kid`.
 * @param nowMs - Current time in milliseconds.
 * @returns The validated claims.
 * @throws {CliTokenError} When any header, signature, claim, or time check fails.
 */
export async function verifyCliAccessToken(
  token: string,
  resolveKey: CliKeyResolver,
  nowMs: number,
): Promise<CliAccessClaims> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new CliTokenError();
  }

  if (header.alg !== "EdDSA") {
    throw new CliTokenError();
  }
  if (typeof header.kid !== "string" || !ulidSchema.safeParse(header.kid).success) {
    throw new CliTokenError();
  }

  const key = await resolveKey(header.kid);
  if (key === undefined) {
    throw new CliTokenError();
  }

  let payload: unknown;
  try {
    const verified = await jwtVerify(token, key, {
      algorithms: ["EdDSA"],
      issuer: CLI_JWT_ISSUER,
      audience: CLI_JWT_AUDIENCE,
      clockTolerance: CLOCK_SKEW_SECONDS,
      currentDate: new Date(nowMs),
    });
    payload = verified.payload;
  } catch {
    throw new CliTokenError();
  }

  const parsed = claimsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CliTokenError();
  }

  const claims = parsed.data;
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS || claims.exp <= claims.iat) {
    throw new CliTokenError();
  }

  return claims;
}
