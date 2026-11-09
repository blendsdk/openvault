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
    headers: { "User-Agent": "openvault-cli/1.2.0" },
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

/**
 * Reports whether two HTTPS URLs identify the same origin.
 *
 * The comparison uses the parsed `origin`, so scheme, host, and port must all
 * match. Default ports normalize (`https://vault.example` equals
 * `https://vault.example:443`). Invalid, non-HTTPS, or opaque URLs return false.
 *
 * @param left - First URL.
 * @param right - Second URL.
 * @returns True when both URLs have the same HTTPS origin.
 *
 * @example
 * ```ts
 * sameCredentialOrigin("https://vault.example/a", "https://vault.example:443/b"); // true
 * sameCredentialOrigin("https://vault.example", "https://other.example"); // false
 * ```
 */
export function sameCredentialOrigin(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.protocol === "https:" &&
      rightUrl.protocol === "https:" &&
      leftUrl.origin === rightUrl.origin
    );
  } catch {
    return false;
  }
}

/** Options for {@link createAuthenticatedClient}. */
export interface AuthenticatedClientOptions {
  /** Credential store. */
  readonly credentials: CredentialStore;
  /** Transport built for the stored base URL. */
  readonly transport: HttpsAdapter;
  /** Process boundary. */
  readonly runtime: CliRuntime;
  /** Origin read from the same credential document that built the transport. */
  readonly baseUrl?: string;
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
  const baseUrl = options.baseUrl ?? document.baseUrl;
  const requireSameServer = (current: { readonly baseUrl: string }): void => {
    if (!sameCredentialOrigin(current.baseUrl, baseUrl)) {
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
    headers: { "User-Agent": "openvault-cli/1.2.0" },
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
