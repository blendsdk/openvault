import type { Logger } from "blendsdk/webafx";
import type { LocalCredential } from "./credentials.js";
import { dummyVerify, isPolicyHash, verifyPassword } from "./password.js";

/** Credentials supplied to a local login. */
export interface LocalLoginInput {
  /** Email address supplied by the caller. */
  readonly identifier: string;
  /** Plaintext password. */
  readonly password: string;
}

/** The verified credential fields a caller needs to issue its own credential. */
export interface LocalLoginSuccess {
  /** Principal identifier. */
  readonly principalId: string;
  /** Display name. */
  readonly name: string;
  /** Email address, or null when the principal has none. */
  readonly email: string | null;
  /** True while the principal must change its password. */
  readonly mustChange: boolean;
  /** The verified PHC hash, used for a post-issuance compare-and-swap recheck. */
  readonly passwordHash: string;
}

/** The result of one local login attempt. */
export type LocalLoginResult =
  | { readonly ok: true; readonly credential: LocalLoginSuccess }
  | { readonly ok: false };

/**
 * Normalizes a local login identifier.
 *
 * Surrounding whitespace is removed and the email is lowercased. The same
 * function is used for lookup and for the per-account rate-limit key so both
 * surfaces share one bucket.
 *
 * @param value - Raw identifier from the request body.
 * @returns The canonical lookup value.
 */
export function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Reports whether a credential lock is still active.
 *
 * @param lockedUntil - Stored lock expiry, or null.
 * @param now - Current time in milliseconds.
 * @returns True while the lock is in the future.
 */
export function isLocked(lockedUntil: Date | null, now: number): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now;
}

/** The credential operations the shared login service depends on. */
export interface LocalLoginCredentials {
  /** Loads a credential by normalized email. */
  findByIdentifier(identifier: string): Promise<LocalCredential | undefined>;
  /** Loads a credential by principal id. */
  findByPrincipalId(principalId: string): Promise<LocalCredential | undefined>;
  /** Records one failed login atomically. */
  recordFailure(
    principalId: string,
    expectedHash: string,
  ): Promise<{ failedCount: number; lockedUntil: Date | null }>;
  /** Resets the failure counter after a successful login. */
  recordSuccess(principalId: string, expectedHash: string): Promise<boolean>;
}

/**
 * Runs the shared local credential verification flow.
 *
 * The service deliberately returns one generic failure for an unknown user, a
 * disabled principal, a locked account, a malformed stored hash, and a wrong
 * password. Every generic path spends one dummy Argon2 verification so timing
 * does not reveal which condition was true. Only a genuine wrong password
 * increments the lockout counter.
 */
export class LocalLoginService {
  readonly #credentials: LocalLoginCredentials;

  /**
   * @param options - Credential repository used for lookup and counters.
   */
  public constructor(options: { readonly credentials: LocalLoginCredentials }) {
    this.#credentials = options.credentials;
  }

  /**
   * Verifies one local credential without creating a session or token.
   *
   * @param input - Identifier and password from the login request.
   * @param log - Optional request logger for safe diagnostic fields.
   * @returns The verified credential, or the generic failure result.
   */
  public async login(input: LocalLoginInput, log?: Logger): Promise<LocalLoginResult> {
    const identifier = normalizeIdentifier(input.identifier);
    const credential = await this.#credentials.findByIdentifier(identifier);

    if (credential === undefined) {
      await dummyVerify(input.password);
      return { ok: false };
    }
    if (credential.status !== "active") {
      await dummyVerify(input.password);
      return { ok: false };
    }
    if (isLocked(credential.lockedUntil, Date.now())) {
      await dummyVerify(input.password);
      return { ok: false };
    }
    if (!isPolicyHash(credential.passwordHash)) {
      await log?.warn("stored password hash rejected", {
        principalId: credential.principalId,
      });
      await dummyVerify(input.password);
      return { ok: false };
    }
    if (!(await verifyPassword(input.password, credential.passwordHash))) {
      await this.#credentials.recordFailure(credential.principalId, credential.passwordHash);
      return { ok: false };
    }

    const reset = await this.#credentials.recordSuccess(
      credential.principalId,
      credential.passwordHash,
    );
    if (!reset) {
      return { ok: false };
    }

    return {
      ok: true,
      credential: {
        principalId: credential.principalId,
        name: credential.name,
        email: credential.email,
        mustChange: credential.mustChange,
        passwordHash: credential.passwordHash,
      },
    };
  }

  /**
   * Rechecks the credential hash after a credential was issued.
   *
   * The browser caller revokes its new session when this returns false. The
   * CLI login uses the family repository's lock-through-insert recheck instead,
   * because a plain re-read does not block on an uncommitted password update.
   *
   * @param principalId - Principal whose credential should be re-read.
   * @param expectedHash - Hash that was verified for the login.
   * @returns True when the stored hash still matches.
   */
  public async revalidate(principalId: string, expectedHash: string): Promise<boolean> {
    const latest = await this.#credentials.findByPrincipalId(principalId);
    return latest !== undefined && latest.passwordHash === expectedHash;
  }
}
