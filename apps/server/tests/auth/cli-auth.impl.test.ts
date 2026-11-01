import { describe, expect, it } from "vitest";
import {
  type CliAccessSigner,
  CliAuthService,
  type CliFamilyStore,
} from "../../src/auth/cli-auth-service.js";
import type {
  CliRequestContext,
  CreatedCliFamily,
  CreateFamilyResult,
} from "../../src/auth/cli-sessions.js";
import type { LocalLoginSuccess } from "../../src/auth/local-login.js";
import { SigningKeyUnavailableError } from "../../src/security/signing-keys.js";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FAMILY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const REFRESH_TOKEN = "A".repeat(43);

const credential: LocalLoginSuccess = {
  principalId: PRINCIPAL_ID,
  name: "CLI User",
  email: "cli@example.test",
  mustChange: false,
  passwordHash: "$argon2id$test",
};

function createdFamily(): CreatedCliFamily {
  return {
    refreshToken: REFRESH_TOKEN,
    row: {
      rowId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      principalId: PRINCIPAL_ID,
      familyId: FAMILY_ID,
      expiresAt: new Date(1_700_043_200_000),
      revokedAt: null,
      createdAt: new Date(1_700_000_000_000),
      ip: null,
      userAgent: null,
    },
  };
}

class RecordingFamilyStore implements CliFamilyStore {
  public readonly revoked: Array<readonly [string, string]> = [];
  public result: CreateFamilyResult = { kind: "created", family: createdFamily() };

  public async createFamilyForLogin(
    _principalId: string,
    _expectedHash: string,
    _context: CliRequestContext,
  ): Promise<CreateFamilyResult> {
    return this.result;
  }

  public async revokeFamily(familyId: string, principalId: string): Promise<void> {
    this.revoked.push([familyId, principalId]);
  }
}

class FixedSigner implements CliAccessSigner {
  public async signAccessToken(): Promise<{ token: string; expiresAt: number }> {
    return {
      token: "header.payload.signature",
      expiresAt: 1_700_000_900_000,
    };
  }
}

class FailingSigner implements CliAccessSigner {
  public async signAccessToken(): Promise<{ token: string; expiresAt: number }> {
    throw new SigningKeyUnavailableError();
  }
}

describe("CLI login issuance", () => {
  it("should assemble the token response from the issued family", async () => {
    const store = new RecordingFamilyStore();
    const service = new CliAuthService({ sessions: store, signingKeys: new FixedSigner() });

    const result = await service.login(credential, { ip: null, userAgent: null });

    expect(result).toEqual({
      kind: "issued",
      response: {
        accessToken: "header.payload.signature",
        refreshToken: REFRESH_TOKEN,
        tokenType: "Bearer",
        accessExpiresAt: new Date(1_700_000_900_000).toISOString(),
        refreshExpiresAt: new Date(1_700_043_200_000).toISOString(),
        user: {
          id: PRINCIPAL_ID,
          name: "CLI User",
          email: "cli@example.test",
          authMethod: "local",
        },
        mustChangePassword: false,
      },
    });
    expect(store.revoked).toEqual([]);
  });

  it("should return credential_changed without signing or revoking", async () => {
    const store = new RecordingFamilyStore();
    store.result = { kind: "credential_changed" };
    const service = new CliAuthService({ sessions: store, signingKeys: new FailingSigner() });

    await expect(service.login(credential, { ip: null, userAgent: null })).resolves.toEqual({
      kind: "credential_changed",
    });
    expect(store.revoked).toEqual([]);
  });

  it("should revoke the new family and rethrow when signing fails", async () => {
    const store = new RecordingFamilyStore();
    const service = new CliAuthService({ sessions: store, signingKeys: new FailingSigner() });

    await expect(service.login(credential, { ip: null, userAgent: null })).rejects.toBeInstanceOf(
      SigningKeyUnavailableError,
    );
    expect(store.revoked).toEqual([[FAMILY_ID, PRINCIPAL_ID]]);
  });
});
