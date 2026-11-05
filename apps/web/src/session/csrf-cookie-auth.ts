import type { AdapterRequest, AuthStrategy } from "blendsdk/api-client";

/** Methods that never carry a CSRF token. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The live session values the strategy reads on every request. */
export interface CsrfSessionSource {
  /** Returns the current CSRF token, or null before the first session check. */
  currentToken(): string | null;
  /** Attempts one session refresh. */
  refresh(): Promise<boolean>;
}

/**
 * Cookie-session authentication with a per-request CSRF header.
 *
 * The browser cookie is HttpOnly; this strategy only sets `credentials:
 * "include"` and copies the live token onto unsafe methods. The token is read
 * from the session source on every call so a refresh cannot leave a stale
 * header behind.
 *
 * @example
 * ```ts
 * const auth = new CsrfCookieAuth({ currentToken: () => token, refresh });
 * const client = createOpenVaultWebClient({ baseUrl: "", auth });
 * ```
 */
export class CsrfCookieAuth implements AuthStrategy {
  /** The OpenAPI security-scheme name this strategy satisfies. */
  public readonly scheme = "cookie";

  readonly #source: CsrfSessionSource;

  /**
   * @param source - Live token and refresh collaborators.
   */
  public constructor(source: CsrfSessionSource) {
    this.#source = source;
  }

  /** Adds browser credentials and, for mutations, the current CSRF token. */
  public async apply(request: AdapterRequest): Promise<AdapterRequest> {
    const headers = { ...request.headers };
    if (!SAFE_METHODS.has(request.method.toUpperCase())) {
      const token = this.#source.currentToken();
      if (token !== null && token.length > 0) {
        headers["x-csrf-token"] = token;
      }
    }
    return { ...request, headers, credentials: "include" };
  }

  /**
   * Refreshes the session after one 401.
   *
   * A successful refresh rotates both the session cookie and the CSRF token.
   * The next request reads the refreshed token from the same source.
   */
  public async refreshOnUnauthorized(): Promise<boolean> {
    return await this.#source.refresh();
  }
}
