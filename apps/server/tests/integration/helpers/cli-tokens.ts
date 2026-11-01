import { generateKeyPair, generateSecret, SignJWT } from "jose";
import { testUlid } from "./fixtures.js";

/** Well-formed identifiers used by forged tokens when a test has no real one. */
const FORGED_SUBJECT = testUlid(901);
const FORGED_FAMILY = testUlid(902);
const FORGED_JTI = testUlid(903);
const FORGED_KID = testUlid(904);

/** Lazily generated Ed25519 key that the integration server does not know. */
let forgedSigningKey: Promise<CryptoKey> | undefined;

/** Returns the private key used to forge structurally valid, untrusted tokens. */
function getForgedSigningKey(): Promise<CryptoKey> {
  forgedSigningKey ??= generateKeyPair("Ed25519").then(({ privateKey }) => privateKey);
  return forgedSigningKey;
}

/** Claim overrides for {@link createForgedAccessToken}. */
export interface ForgedAccessTokenOptions {
  /** Signing algorithm; the test key is Ed25519 unless HS256 is requested. */
  readonly algorithm?: "EdDSA" | "HS256";
  /** Key identifier placed in the protected header. */
  readonly kid?: string;
  /** Issuer claim. */
  readonly issuer?: string;
  /** Audience claim. */
  readonly audience?: string;
  /** Subject claim, normally a principal identifier. */
  readonly subject?: string;
  /** Refresh family identifier placed in the `sid` claim. */
  readonly familyId?: string;
  /** Token identifier claim. */
  readonly jti?: string;
  /** Subject kind claim. */
  readonly kind?: string;
  /** Issued-at time in Unix seconds. */
  readonly issuedAt?: number;
  /** Expiry time in Unix seconds. */
  readonly expiresAt?: number;
}

/**
 * Builds an access token signed by a key the server does not trust.
 *
 * These tokens are structurally complete so a rejection proves the server
 * validates the key, algorithm, and claims rather than merely rejecting
 * arbitrary strings. The key pair is generated inside the test process and is
 * never registered with the server.
 *
 * @param options - Claim and header overrides.
 * @returns A signed JWT string.
 */
export async function createForgedAccessToken(
  options: ForgedAccessTokenOptions = {},
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    iss: options.issuer ?? "openvault",
    aud: options.audience ?? "openvault-cli",
    sub: options.subject ?? FORGED_SUBJECT,
    sid: options.familyId ?? FORGED_FAMILY,
    jti: options.jti ?? FORGED_JTI,
    iat: options.issuedAt ?? nowSeconds,
    exp: options.expiresAt ?? nowSeconds + 900,
    kind: options.kind ?? "user",
  };
  const kid = options.kid ?? FORGED_KID;

  if (options.algorithm === "HS256") {
    const secret = await generateSecret("HS256");
    return new SignJWT(payload).setProtectedHeader({ alg: "HS256", kid }).sign(secret);
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA", kid })
    .sign(await getForgedSigningKey());
}

/**
 * Changes one character of a signed token's signature.
 *
 * The header and payload stay valid, so the request fails only because the
 * signature no longer matches the signed bytes.
 *
 * @param token - Complete compact JWT.
 * @returns The token with a broken signature.
 */
export function tamperAccessToken(token: string): string {
  const parts = token.split(".");
  const header = parts[0];
  const payload = parts[1];
  const signature = parts[2];
  if (
    parts.length !== 3 ||
    header === undefined ||
    payload === undefined ||
    signature === undefined
  ) {
    throw new Error("expected a three-part JWT");
  }
  const replacement = signature.endsWith("A") ? "B" : "A";
  return `${header}.${payload}.${signature.slice(0, -1)}${replacement}`;
}
