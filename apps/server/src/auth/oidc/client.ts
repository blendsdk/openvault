import * as client from "openid-client";
import type { OidcConfig } from "../../config/types.js";
import { OidcFlowError, OidcUnavailableError } from "./errors.js";
import { sanitizeReturnTo } from "./return-to.js";

const REQUEST_TIMEOUT_MS = 5_000;
const DISCOVERY_TTL_MS = 3_600_000;
const SCOPES = "openid profile email";

/** Options for {@link OidcClient}. */
export interface OidcClientOptions {
  /** Validated OIDC settings. */
  readonly config: OidcConfig;
  /** Fetch implementation; tests inject one that trusts the fixture CA. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable clock for discovery expiry. */
  readonly now?: () => number;
}

/** The values produced by an authorization request. */
export interface OidcAuthorization {
  /** Provider authorization URL. */
  readonly url: string;
  /** Opaque state parameter. */
  readonly state: string;
  /** OpenID Connect nonce. */
  readonly nonce: string;
  /** PKCE code verifier. */
  readonly codeVerifier: string;
  /** Sanitized post-login path. */
  readonly returnTo: string;
}

/** The identity result of a successful code exchange. */
export interface OidcExchangeResult {
  /** Verified ID-token subject. */
  readonly subject: string;
  /** Verified ID-token claims. */
  readonly claims: Record<string, unknown>;
  /** UserInfo claims, already checked against the subject. */
  readonly userInfo: Record<string, unknown>;
}

interface CachedDiscovery {
  readonly configuration: client.Configuration;
  readonly expiresAt: number;
}

function toBodyInit(body: client.FetchBody): BodyInit | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string" || body instanceof URLSearchParams) {
    return body;
  }
  if (body instanceof ArrayBuffer || body instanceof ReadableStream) {
    return body;
  }
  return Buffer.from(body).toString("utf8");
}

function mapOidcError(error: unknown): Error {
  if (error instanceof OidcFlowError || error instanceof OidcUnavailableError) {
    return error;
  }
  if (error instanceof client.ResponseBodyError) {
    return error.status >= 500 ? new OidcUnavailableError() : new OidcFlowError();
  }
  if (error instanceof client.WWWAuthenticateChallengeError) {
    return error.status >= 500 ? new OidcUnavailableError() : new OidcFlowError();
  }
  if (error instanceof client.ClientError) {
    if (error.code === "OAUTH_TIMEOUT" || error.code === "OAUTH_ABORTED") {
      return new OidcUnavailableError();
    }
    return new OidcFlowError();
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new OidcUnavailableError();
  }
  return new OidcUnavailableError();
}

/**
 * OIDC authorization-code client built on `openid-client`.
 *
 * The client discovers the provider, builds a PKCE S256 authorization URL,
 * exchanges the code with the nonce, and fetches UserInfo. It returns only the
 * verified identity; access, refresh, and ID tokens never leave this class.
 */
export class OidcClient {
  readonly #config: OidcConfig;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #timedFetch: client.CustomFetch;
  #discovery: CachedDiscovery | undefined;

  /**
   * @param options - Provider configuration and test seams.
   */
  public constructor(options: OidcClientOptions) {
    this.#config = options.config;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#timedFetch = (url, request) => {
      const body = toBodyInit(request.body);
      const init: RequestInit = {
        headers: request.headers,
        method: request.method,
        redirect: request.redirect,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(body === undefined ? {} : { body }),
      };
      return this.#fetch(url, init);
    };
  }

  /**
   * Builds a PKCE authorization URL and the transient values to store.
   *
   * @param input - Optional untrusted post-login path.
   * @returns The provider URL, state, nonce, verifier, and sanitized path.
   */
  public async buildAuthorizationUrl(input: {
    readonly returnTo?: string;
  }): Promise<OidcAuthorization> {
    const configuration = await this.#configuration();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.#config.redirectUrl.href,
      scope: SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });

    return {
      url: url.href,
      state,
      nonce,
      codeVerifier,
      returnTo: sanitizeReturnTo(input.returnTo, this.#config.redirectUrl),
    };
  }

  /**
   * Exchanges an authorization code and fetches the matching UserInfo.
   *
   * @param input - Callback URL and the transient state values.
   * @returns The verified subject, ID-token claims, and UserInfo.
   * @throws {OidcFlowError} For a bad code, state, nonce, ID token, or subject.
   * @throws {OidcUnavailableError} For discovery, network, or provider outages.
   */
  public async exchangeCode(input: {
    readonly callbackUrl: URL;
    readonly codeVerifier: string;
    readonly nonce: string;
  }): Promise<OidcExchangeResult> {
    const configuration = await this.#configuration();

    let response: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      response = await client.authorizationCodeGrant(configuration, input.callbackUrl, {
        pkceCodeVerifier: input.codeVerifier,
        expectedNonce: input.nonce,
        expectedState: client.skipStateCheck,
        idTokenExpected: true,
      });
    } catch (error) {
      throw mapOidcError(error);
    }

    const claims = response.claims();
    const subject = claims?.sub;
    if (claims === undefined || typeof subject !== "string") {
      throw new OidcFlowError();
    }

    let userInfo: Awaited<ReturnType<typeof client.fetchUserInfo>>;
    try {
      userInfo = await client.fetchUserInfo(
        configuration,
        response.access_token,
        client.skipSubjectCheck,
      );
    } catch (error) {
      throw mapOidcError(error);
    }
    if (userInfo.sub !== subject) {
      throw new OidcFlowError();
    }

    return { subject, claims: { ...claims }, userInfo: { ...userInfo } };
  }

  /**
   * Checks whether discovery succeeds. An outage is reported as `false`; it is
   * not a readiness dependency.
   *
   * @returns True when the provider discovery document is usable.
   */
  public async health(): Promise<boolean> {
    try {
      await this.#configuration();
      return true;
    } catch {
      return false;
    }
  }

  /** Clears the cached discovery document. */
  public async shutdown(): Promise<void> {
    this.#discovery = undefined;
  }

  async #configuration(): Promise<client.Configuration> {
    if (this.#discovery !== undefined && this.#discovery.expiresAt > this.#now()) {
      return this.#discovery.configuration;
    }

    let configuration: client.Configuration;
    try {
      configuration = await client.discovery(
        new URL(this.#config.issuer.href),
        this.#config.clientId,
        { client_secret: this.#config.clientSecret },
        client.ClientSecretBasic(this.#config.clientSecret),
        { [client.customFetch]: this.#timedFetch },
      );
    } catch {
      throw new OidcUnavailableError();
    }

    client.enableNonRepudiationChecks(configuration);
    const metadata = configuration.serverMetadata();
    if (metadata.issuer !== this.#config.issuer.href) {
      throw new OidcUnavailableError("OIDC issuer mismatch");
    }

    this.#discovery = {
      configuration,
      expiresAt: this.#now() + DISCOVERY_TTL_MS,
    };
    return configuration;
  }
}
