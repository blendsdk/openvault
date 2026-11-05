import { ApiError, BearerAuth } from "blendsdk/api-client";
import type { CredentialStore } from "../credentials/store.js";
import { RefreshRejectedError } from "../errors.js";
import { createOpenVaultClient, type OpenVaultClient } from "../generated/index.js";
import type { HttpsAdapter } from "../transport/https-adapter.js";
import type { CliRuntime } from "../types.js";

/** The unauthenticated client used by login, refresh, and logout. */
export function createAnonymousClient(transport: HttpsAdapter, baseUrl: string): OpenVaultClient {
  return createOpenVaultClient({
    baseUrl,
    adapter: transport,
    headers: { "User-Agent": "openvault-cli/0.1.0" },
  });
}

/** An authenticated client plus the header helper for raw calls. */
export interface AuthenticatedClient {
  /** Generated typed client. */
  readonly client: OpenVaultClient;
  /** Transport used by raw probe/download calls. */
  readonly transport: HttpsAdapter;
  /** Returns the current bearer header. */
  authHeaders(): Promise<Record<string, string>>;
  /** Refreshes the access token and returns the new value. */
  refreshAccessToken(): Promise<string>;
}

/** Options for {@link createAuthenticatedClient}. */
export interface AuthenticatedClientOptions {
  /** Credential store. */
  readonly credentials: CredentialStore;
  /** Transport built for the stored base URL. */
  readonly transport: HttpsAdapter;
  /** Process boundary. */
  readonly runtime: CliRuntime;
}

/**
 * Builds the authenticated client with a locked refresh flow.
 *
 * @param options - Credential store, transport, and runtime.
 * @returns The typed client and header helper.
 * @throws {RefreshRejectedError} When no credential exists.
 */
export function createAuthenticatedClient(
  options: AuthenticatedClientOptions,
): AuthenticatedClient {
  const document = options.credentials.load();
  if (document === undefined) {
    throw new RefreshRejectedError();
  }
  const baseUrl = document.baseUrl;
  const expectedOrigin = new URL(baseUrl).origin;
  const requireSameServer = (current: { readonly baseUrl: string }): void => {
    let currentOrigin: string | undefined;
    try {
      currentOrigin = new URL(current.baseUrl).origin;
    } catch {
      currentOrigin = undefined;
    }
    if (currentOrigin !== expectedOrigin) {
      throw new RefreshRejectedError(
        "The credential file belongs to a different server; run ov login again",
      );
    }
  };

  const refresh = async (): Promise<string> =>
    await options.credentials.withLock(async () => {
      const current = options.credentials.load();
      if (current === undefined) {
        throw new RefreshRejectedError();
      }
      requireSameServer(current);
      const anonymous = createAnonymousClient(options.transport, baseUrl);
      try {
        const response = await anonymous.auth.refreshCli({ refreshToken: current.refreshToken });
        options.credentials.save({
          version: 1,
          baseUrl: current.baseUrl,
          accessToken: response.accessToken,
          refreshToken: response.refreshToken,
          accessExpiresAt: response.accessExpiresAt,
          refreshExpiresAt: response.refreshExpiresAt,
        });
        return response.accessToken;
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 401) {
          throw new RefreshRejectedError();
        }
        throw error;
      }
    });

  const currentToken = (): string => {
    const current = options.credentials.load();
    if (current === undefined) {
      throw new RefreshRejectedError();
    }
    requireSameServer(current);
    return current.accessToken;
  };

  const client = createOpenVaultClient({
    baseUrl,
    adapter: options.transport,
    headers: { "User-Agent": "openvault-cli/0.1.0" },
    auth: new BearerAuth({
      getToken: currentToken,
      refresh,
    }),
  });

  return {
    client,
    transport: options.transport,
    async authHeaders(): Promise<Record<string, string>> {
      return { Authorization: `Bearer ${currentToken()}` };
    },
    refreshAccessToken: refresh,
  };
}
