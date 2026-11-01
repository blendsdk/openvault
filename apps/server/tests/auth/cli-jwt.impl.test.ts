import { decodeJwt, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CLI_ACCESS_TOKEN_TTL_SECONDS,
  CLI_JWT_AUDIENCE,
  CLI_JWT_ISSUER,
  CliTokenError,
  signCliAccessToken,
  verifyCliAccessToken,
} from "../../src/auth/cli-jwt.js";

const NOW_MS = Date.parse("2026-10-30T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const KID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SUB = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const SID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const JTI = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeAll(async () => {
  ({ privateKey, publicKey } = await generateKeyPair("Ed25519"));
});

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: CLI_JWT_ISSUER,
    aud: CLI_JWT_AUDIENCE,
    sub: SUB,
    sid: SID,
    jti: JTI,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + CLI_ACCESS_TOKEN_TTL_SECONDS,
    kind: "user",
    ...overrides,
  };
}

async function resolveKey(kid: string): Promise<CryptoKey | undefined> {
  return kid === KID ? publicKey : undefined;
}

async function sign(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: "EdDSA", kid: KID }).sign(privateKey);
}

describe("CLI JWT signing details", () => {
  it("should use the fixed issuer, audience, lifetime, and millisecond expiry", async () => {
    const issued = await signCliAccessToken({
      privateKey,
      kid: KID,
      principalId: SUB,
      familyId: SID,
      nowMs: NOW_MS + 123,
    });
    const payload = decodeJwt(issued.token);

    expect(issued.expiresAt).toBe((NOW_SECONDS + CLI_ACCESS_TOKEN_TTL_SECONDS) * 1_000);
    expect(payload.iss).toBe(CLI_JWT_ISSUER);
    expect(payload.aud).toBe(CLI_JWT_AUDIENCE);
    expect(payload.sub).toBe(SUB);
    expect(payload.sid).toBe(SID);
    expect(payload.kind).toBe("user");
    expect(Number(payload.exp) - Number(payload.iat)).toBe(CLI_ACCESS_TOKEN_TTL_SECONDS);
    expect(issued.token.split(".")).toHaveLength(3);
  });
});

describe("CLI JWT verification boundaries", () => {
  it("should accept the exact clock-skew boundaries", async () => {
    const future = await sign(
      claims({
        iat: NOW_SECONDS + 30,
        exp: NOW_SECONDS + 30 + CLI_ACCESS_TOKEN_TTL_SECONDS,
      }),
    );
    const expired = await sign(
      claims({
        iat: NOW_SECONDS - 30 - CLI_ACCESS_TOKEN_TTL_SECONDS,
        exp: NOW_SECONDS - 30,
      }),
    );

    await expect(verifyCliAccessToken(future, resolveKey, NOW_MS)).resolves.toMatchObject({
      sub: SUB,
    });
    await expect(verifyCliAccessToken(expired, resolveKey, NOW_MS)).resolves.toMatchObject({
      sid: SID,
    });
  });

  it("should reject one second beyond either boundary", async () => {
    const future = await sign(
      claims({
        iat: NOW_SECONDS + 31,
        exp: NOW_SECONDS + 31 + CLI_ACCESS_TOKEN_TTL_SECONDS,
      }),
    );
    const expired = await sign(
      claims({
        iat: NOW_SECONDS - 31 - CLI_ACCESS_TOKEN_TTL_SECONDS,
        exp: NOW_SECONDS - 31,
      }),
    );

    await expect(verifyCliAccessToken(future, resolveKey, NOW_MS)).rejects.toBeInstanceOf(
      CliTokenError,
    );
    await expect(verifyCliAccessToken(expired, resolveKey, NOW_MS)).rejects.toBeInstanceOf(
      CliTokenError,
    );
  });

  it("should propagate a key-resolution infrastructure failure", async () => {
    const token = await sign(claims());
    const failure = new Error("keyring unavailable");
    const resolver = async (): Promise<CryptoKey | undefined> => {
      throw failure;
    };

    await expect(verifyCliAccessToken(token, resolver, NOW_MS)).rejects.toBe(failure);
  });
});
