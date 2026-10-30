import { createHash } from "node:crypto";
import type { CacheProvider } from "blendsdk/webafx-cache";

const STATE_KEY_PREFIX = "oidc:state:";
const STATE_TTL_SECONDS = 600;

/** Transient values captured at the authorization request. */
export interface OidcState {
  /** PKCE code verifier. */
  readonly codeVerifier: string;
  /** OpenID Connect nonce. */
  readonly nonce: string;
  /** Sanitized post-login redirect. */
  readonly returnTo: string;
}

function stateKey(state: string): string {
  return `${STATE_KEY_PREFIX}${createHash("sha256").update(state, "utf8").digest("hex")}`;
}

/**
 * Stores one-use OIDC authorization state in the shared memory cache.
 *
 * `take` is single-use: a concurrent callback for the same state is rejected
 * while the first consume is in flight. The TTL is ten minutes.
 */
export class OidcStateStore {
  readonly #cache: CacheProvider;
  readonly #inFlight = new Set<string>();

  /**
   * @param options - Cache provider for transient state.
   */
  public constructor(options: { readonly cache: CacheProvider }) {
    this.#cache = options.cache;
  }

  /**
   * Stores the state for ten minutes.
   *
   * @param state - Opaque state parameter.
   * @param value - PKCE verifier, nonce, and return path.
   */
  public async put(state: string, value: OidcState): Promise<void> {
    await this.#cache.set(stateKey(state), value, STATE_TTL_SECONDS);
  }

  /**
   * Consumes the state exactly once.
   *
   * @param state - Opaque state parameter.
   * @returns The stored value, or `undefined` when missing or already consumed.
   */
  public async take(state: string): Promise<OidcState | undefined> {
    const key = stateKey(state);
    if (this.#inFlight.has(key)) {
      return undefined;
    }

    this.#inFlight.add(key);
    try {
      const value = await this.#cache.get<OidcState>(key);
      await this.#cache.delete(key);
      return value;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  /**
   * Deletes a state value without consuming it.
   *
   * @param state - Opaque state parameter.
   */
  public async delete(state: string): Promise<void> {
    await this.#cache.delete(stateKey(state));
  }

  /** Clears in-flight markers; the shared cache is owned by the session service. */
  public destroy(): void {
    this.#inFlight.clear();
  }
}
