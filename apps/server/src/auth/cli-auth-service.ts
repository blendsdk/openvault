import type { CliTokenResponse } from "@openvault/api-contract";
import type {
  CliRefreshRow,
  CliRequestContext,
  CreateFamilyResult,
  RotateResult,
} from "./cli-sessions.js";
import type { LocalLoginSuccess } from "./local-login.js";

/** The family operations needed by CLI authentication. */
export interface CliFamilyStore {
  /** Creates a family under the per-principal login lock. */
  createFamilyForLogin(
    principalId: string,
    expectedHash: string,
    context: CliRequestContext,
  ): Promise<CreateFamilyResult>;
  /** Rotates one refresh token under the principal and row locks. */
  rotateRefresh(
    refreshHash: Buffer,
    principalId: string,
    familyId: string,
    context: CliRequestContext,
  ): Promise<RotateResult>;
  /** Revokes the family for a refresh-token hash. */
  logoutByHash(refreshHash: Buffer): Promise<void>;
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

/** Result of one refresh attempt. */
export type RefreshIssueResult =
  | { readonly kind: "issued"; readonly response: CliTokenResponse }
  | { readonly kind: "invalid" }
  | { readonly kind: "expired" }
  | { readonly kind: "reuse" }
  | { readonly kind: "disabled" };

/** Builds the shared token response from one signed access token and family row. */
function tokenResponse(
  access: { readonly token: string; readonly expiresAt: number },
  refreshToken: string,
  row: CliRefreshRow,
  user: { readonly id: string; readonly name: string; readonly email: string | null },
  mustChangePassword: boolean,
): CliTokenResponse {
  return {
    accessToken: access.token,
    refreshToken,
    tokenType: "Bearer",
    accessExpiresAt: new Date(access.expiresAt).toISOString(),
    refreshExpiresAt: row.expiresAt.toISOString(),
    user: { ...user, authMethod: "local" },
    mustChangePassword,
  };
}

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
      response: tokenResponse(
        access,
        family.refreshToken,
        family.row,
        {
          id: credential.principalId,
          name: credential.name,
          email: credential.email,
        },
        credential.mustChange,
      ),
    };
  }

  /**
   * Rotates a refresh token and signs a new access token.
   *
   * @param refreshHash - SHA-256 of the presented refresh token.
   * @param principalId - Owner discovered before the family rate limit.
   * @param familyId - Family discovered before the family rate limit.
   * @param context - Current request address and user agent.
   * @returns The new token response or a stable failure kind.
   * @throws {SigningKeyUnavailableError} When signing fails after a rotation.
   */
  public async refresh(
    refreshHash: Buffer,
    principalId: string,
    familyId: string,
    context: CliRequestContext,
  ): Promise<RefreshIssueResult> {
    const rotated = await this.#sessions.rotateRefresh(refreshHash, principalId, familyId, context);
    if (rotated.kind !== "rotated") {
      return { kind: rotated.kind };
    }

    let access: { readonly token: string; readonly expiresAt: number };
    try {
      access = await this.#signingKeys.signAccessToken({
        principalId,
        familyId,
        nowMs: Date.now(),
      });
    } catch (error) {
      await this.#sessions.revokeFamily(familyId, principalId).catch(() => undefined);
      throw error;
    }

    return {
      kind: "issued",
      response: tokenResponse(
        access,
        rotated.refreshToken,
        rotated.row,
        {
          id: rotated.principal.principalId,
          name: rotated.principal.name,
          email: rotated.principal.email,
        },
        rotated.principal.mustChange,
      ),
    };
  }

  /**
   * Revokes the family for a well-formed refresh token.
   *
   * @param refreshHash - SHA-256 of the presented refresh token.
   */
  public async logout(refreshHash: Buffer): Promise<void> {
    await this.#sessions.logoutByHash(refreshHash);
  }
}
