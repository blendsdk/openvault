import type { CliTokenResponse } from "@openvault/api-contract";
import type { CliRequestContext, CreateFamilyResult } from "./cli-sessions.js";
import type { LocalLoginSuccess } from "./local-login.js";

/** The family operations needed by CLI login. */
export interface CliFamilyStore {
  /** Creates a family under the per-principal login lock. */
  createFamilyForLogin(
    principalId: string,
    expectedHash: string,
    context: CliRequestContext,
  ): Promise<CreateFamilyResult>;
  /** Revokes every live row in one owned family. */
  revokeFamily(familyId: string, principalId: string): Promise<void>;
}

/** The signing operation needed by CLI login. */
export interface CliAccessSigner {
  /** Signs one access token for a principal/family pair. */
  signAccessToken(input: {
    readonly principalId: string;
    readonly familyId: string;
    readonly nowMs: number;
  }): Promise<{ readonly token: string; readonly expiresAt: number }>;
}

/** Result of issuing a CLI login credential. */
export type LoginIssueResult =
  | { readonly kind: "issued"; readonly response: CliTokenResponse }
  | { readonly kind: "credential_changed" };

/**
 * Turns a verified local credential into a CLI token family.
 *
 * The service intentionally owns no HTTP concerns. It creates the family under
 * the repository's principal lock, signs the access token, and revokes the
 * family if signing fails so a client never receives a half-issued credential.
 */
export class CliAuthService {
  readonly #sessions: CliFamilyStore;
  readonly #signingKeys: CliAccessSigner;

  /**
   * @param options - Family repository and signing service.
   */
  public constructor(options: {
    readonly sessions: CliFamilyStore;
    readonly signingKeys: CliAccessSigner;
  }) {
    this.#sessions = options.sessions;
    this.#signingKeys = options.signingKeys;
  }

  /**
   * Issues one access token and refresh family for a verified credential.
   *
   * @param credential - Verified local credential.
   * @param context - Login address and user agent.
   * @returns The token response, or a credential-changed result.
   * @throws {SigningKeyUnavailableError} When the access token cannot be signed.
   */
  public async login(
    credential: LocalLoginSuccess,
    context: CliRequestContext,
  ): Promise<LoginIssueResult> {
    const created = await this.#sessions.createFamilyForLogin(
      credential.principalId,
      credential.passwordHash,
      context,
    );
    if (created.kind === "credential_changed") {
      return created;
    }

    const family = created.family;
    let access: { readonly token: string; readonly expiresAt: number };
    try {
      access = await this.#signingKeys.signAccessToken({
        principalId: credential.principalId,
        familyId: family.row.familyId,
        nowMs: Date.now(),
      });
    } catch (error) {
      await this.#sessions
        .revokeFamily(family.row.familyId, credential.principalId)
        .catch(() => undefined);
      throw error;
    }

    return {
      kind: "issued",
      response: {
        accessToken: access.token,
        refreshToken: family.refreshToken,
        tokenType: "Bearer",
        accessExpiresAt: new Date(access.expiresAt).toISOString(),
        refreshExpiresAt: family.row.expiresAt.toISOString(),
        user: {
          id: credential.principalId,
          name: credential.name,
          email: credential.email,
          authMethod: "local",
        },
        mustChangePassword: credential.mustChange,
      },
    };
  }
}
