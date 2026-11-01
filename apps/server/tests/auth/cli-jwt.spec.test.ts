import { decodeJwt, decodeProtectedHeader, generateKeyPair, generateSecret, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { CliTokenError, verifyCliAccessToken } from "../../src/auth/cli-jwt.js";

const NOW_MS = Date.parse("2026-10-30T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const ACCESS_LIFETIME_SECONDS = 900;
const CLOCK_SKEW_SECONDS = 30;

const KID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SUB = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const SID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const JTI = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const UNKNOWN_KID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let otherPrivateKey: CryptoKey;

beforeAll(async () => {
  ({ privateKey, publicKey } = await generateKeyPair("Ed25519"));
  ({ privateKey: otherPrivateKey } = await generateKeyPair("Ed25519"));
});

/** Builds a complete claim set for one access token. */
function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "openvault",
    aud: "openvault-cli",
    sub: SUB,
    sid: SID,
    jti: JTI,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + ACCESS_LIFETIME_SECONDS,
    kind: "user",
    ...overrides,
  };
}

interface SignOptions {
  readonly alg?: string;
  readonly kid?: string;
  readonly key?: CryptoKey;
}

/** Signs a token with the test key unless a different key is supplied. */
async function signToken(
  payload: Record<string, unknown>,
  options: SignOptions = {},
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: options.alg ?? "EdDSA", kid: options.kid ?? KID })
    .sign(options.key ?? privateKey);
}

/** Signs an HS256 token with a freshly generated symmetric secret. */
async function signHs256(payload: Record<string, unknown>): Promise<string> {
  const secret = await generateSecret("HS256");
  return new SignJWT(payload).setProtectedHeader({ alg: "HS256", kid: KID }).sign(secret);
}

/** Records the key ids the verifier asks the resolver to look up. */
const resolvedKids: string[] = [];

/** Resolves only the known test key. */
async function resolveKey(kid: string): Promise<CryptoKey | undefined> {
  resolvedKids.push(kid);
  return kid === KID ? publicKey : undefined;
}

/** Clears the resolver call log before one assertion. */
function resetResolverCalls(): void {
  resolvedKids.length = 0;
}

/** Asserts that verification failed with the stable CLI token error. */
async function expectCliTokenError(verification: Promise<unknown>): Promise<CliTokenError> {
  try {
    await verification;
  } catch (error) {
    expect(error).toBeInstanceOf(CliTokenError);
    if (!(error instanceof CliTokenError)) {
      throw error;
    }
    return error;
  }
  throw new Error("expected verification to reject the token");
}

describe("CLI access token header and payload", () => {
  it("should expose EdDSA and the resolving key id in the header", async () => {
    const token = await signToken(claims());

    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "EdDSA", kid: KID });
  });

  it("should expose exactly the eight documented claims and a 900-second lifetime", async () => {
    const token = await signToken(claims());
    const payload = decodeJwt(token);

    expect(Object.keys(payload).sort()).toEqual([
      "aud",
      "exp",
      "iat",
      "iss",
      "jti",
      "kind",
      "sid",
      "sub",
    ]);
    expect(payload).toMatchObject({
      iss: "openvault",
      aud: "openvault-cli",
      sub: SUB,
      sid: SID,
      jti: JTI,
      kind: "user",
    });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(ACCESS_LIFETIME_SECONDS);
  });
});

describe("valid CLI access tokens", () => {
  it("should accept a valid token and return the exact claims", async () => {
    resetResolverCalls();
    const token = await signToken(claims());

    const result = await verifyCliAccessToken(token, resolveKey, NOW_MS);

    expect(result).toEqual(claims());
    expect(resolvedKids).toEqual([KID]);
  });

  it("should accept a token issued inside the clock skew", async () => {
    const token = await signToken(
      claims({
        iat: NOW_SECONDS + CLOCK_SKEW_SECONDS - 1,
        exp: NOW_SECONDS + CLOCK_SKEW_SECONDS - 1 + ACCESS_LIFETIME_SECONDS,
      }),
    );

    await expect(verifyCliAccessToken(token, resolveKey, NOW_MS)).resolves.toMatchObject({
      sub: SUB,
    });
  });

  it("should accept a token that expired inside the clock skew", async () => {
    const token = await signToken(
      claims({
        iat: NOW_SECONDS - CLOCK_SKEW_SECONDS + 1 - ACCESS_LIFETIME_SECONDS,
        exp: NOW_SECONDS - CLOCK_SKEW_SECONDS + 1,
      }),
    );

    await expect(verifyCliAccessToken(token, resolveKey, NOW_MS)).resolves.toMatchObject({
      sid: SID,
    });
  });
});

describe("algorithm and signature checks", () => {
  it("should reject an HS256 token when EdDSA is required", async () => {
    const token = await signHs256(claims());

    await expectCliTokenError(verifyCliAccessToken(token, resolveKey, NOW_MS));
  });

  it("should reject a token whose signature was produced by another key", async () => {
    const token = await signToken(claims(), { key: otherPrivateKey });

    await expectCliTokenError(verifyCliAccessToken(token, resolveKey, NOW_MS));
  });

  it("should reject a malformed compact token without asking the resolver for a key", async () => {
    resetResolverCalls();

    for (const token of ["", "not-a-jwt", "a.b.c", "...."]) {
      await expectCliTokenError(verifyCliAccessToken(token, resolveKey, NOW_MS));
    }
    expect(resolvedKids).toHaveLength(0);
  });
});

describe("key id checks", () => {
  it("should reject an unknown kid after asking the resolver for that kid", async () => {
    resetResolverCalls();
    const token = await signToken(claims(), { kid: UNKNOWN_KID });

    await expectCliTokenError(verifyCliAccessToken(token, resolveKey, NOW_MS));
    expect(resolvedKids).toEqual([UNKNOWN_KID]);
  });

  it("should reject a missing kid before resolving a key", async () => {
    resetResolverCalls();
    const token = await new SignJWT(claims()).setProtectedHeader({ alg: "EdDSA" }).sign(privateKey);

    await expectCliTokenError(verifyCliAccessToken(token, resolveKey, NOW_MS));
    expect(resolvedKids).toHaveLength(0);
  });

  it("should reject a malformed kid before resolving a key", async () => {
    resetResolverCalls();

    for (const kid of ["", "not-a-ulid", KID.toLowerCase(), KID.slice(0, 25)]) {
      const token = await signToken(claims(), { kid });
      await expectCliTokenError(verifyCliAccessToken(token, resolveKey, NOW_MS));
    }
    expect(resolvedKids).toHaveLength(0);
  });
});

describe("issuer, audience, and claim checks", () => {
  it("should reject a token with the wrong issuer", async () => {
    const token = await signToken(claims({ iss: "other-issuer" }));

    await expectCliTokenError(verifyCliAccessToken(token, resolveKey, NOW_MS));
  });

  it("should reject a token with the wrong audience", async () => {
    const token = await signToken(claims({ aud: "openvault-browser" }));

    await expectCliTokenError(verifyCliAccessToken(token, resolveKey, NOW_MS));
  });

  it("should reject a token whose kind is not user", async () => {
    for (const kind of ["service", "admin", "system", ""]) {
      const token = await signToken(claims({ kind }));
      await expectCliTokenError(verifyCliAccessToken(token, resolveKey, NOW_MS));
    }
  });

  it("should reject a token without any required claim", async () => {
    for (const claim of ["iss", "aud", "sub", "sid", "jti", "iat", "exp", "kind"]) {
      const payload = claims();
      delete payload[claim];
      const token = await signToken(payload);
      await expectCliTokenError(verifyCliAccessToken(token, resolveKey, NOW_MS));
    }
  });

  it("should reject extra claims", async () => {
    for (const extra of [
      { roles: ["admin"] },
      { email: "alice@example.com" },
      { scope: "secrets.read" },
    ]) {
      const token = await signToken(claims(extra));
      await expectCliTokenError(verifyCliAccessToken(token, resolveKey, NOW_MS));
    }
  });

  it("should reject non-ULID subject, session, and token identifiers", async () => {
    for (const override of [
      { sub: "not-a-ulid" },
      { sid: "not-a-ulid" },
      { jti: "not-a-ulid" },
      { sub: SUB.toLowerCase() },
      { sid: SID.slice(0, 25) },
    ]) {
      const token = await signToken(claims(override));
      await expectCliTokenError(verifyCliAccessToken(token, resolveKey, NOW_MS));
    }
  });
});

describe("time checks", () => {
  it("should reject a token issued beyond the clock skew", async () => {
    const token = await signToken(
      claims({
        iat: NOW_SECONDS + CLOCK_SKEW_SECONDS + 1,
        exp: NOW_SECONDS + CLOCK_SKEW_SECONDS + 1 + ACCESS_LIFETIME_SECONDS,
      }),
    );

    await expectCliTokenError(verifyCliAccessToken(token, resolveKey, NOW_MS));
  });

  it("should reject a token expired beyond the clock skew", async () => {
    const token = await signToken(
      claims({
        iat: NOW_SECONDS - CLOCK_SKEW_SECONDS - ACCESS_LIFETIME_SECONDS - 1,
        exp: NOW_SECONDS - CLOCK_SKEW_SECONDS - 1,
      }),
    );

    await expectCliTokenError(verifyCliAccessToken(token, resolveKey, NOW_MS));
  });

  it("should reject a token that expires at or before its issue time", async () => {
    for (const exp of [NOW_SECONDS, NOW_SECONDS - 1]) {
      const token = await signToken(claims({ exp }));
      await expectCliTokenError(verifyCliAccessToken(token, resolveKey, NOW_MS));
    }
  });

  it("should reject fractional and non-numeric issue and expiry times", async () => {
    for (const override of [
      { iat: NOW_SECONDS + 0.5 },
      { exp: NOW_SECONDS + ACCESS_LIFETIME_SECONDS + 0.5 },
      { iat: String(NOW_SECONDS) },
      { exp: String(NOW_SECONDS + ACCESS_LIFETIME_SECONDS) },
    ]) {
      const token = await signToken(claims(override));
      await expectCliTokenError(verifyCliAccessToken(token, resolveKey, NOW_MS));
    }
  });
});
