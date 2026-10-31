import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, request as httpsRequest, type Server } from "node:https";
import { type CryptoKey, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { createTlsFixture, type TlsFixture } from "./tls.js";

/** Token verbs the browser-free fake fetch must transport for the OIDC library. */
type FetchFunction = typeof globalThis.fetch;

const KEY_ID = "openvault-test-provider-key";
const ID_TOKEN_LIFETIME_SECONDS = 300;

/**
 * A user profile the fake provider asserts through the token and UserInfo
 * endpoints.
 *
 * `emailVerified` is optional on purpose: leaving it out models a provider that
 * never sends the claim, which is different from sending `false`.
 */
export interface FakeOidcUser {
  /** Stable subject identifier for the identity. */
  readonly subject: string;
  /** Email address returned by UserInfo. */
  readonly email: string;
  /** Verification flag; omit the property to send no claim at all. */
  readonly emailVerified?: boolean;
  /** Display name; omit to exercise the email-local-part fallback. */
  readonly name?: string;
}

/** Options for {@link FakeOidcProvider.start}. */
export interface FakeOidcProviderOptions {
  /** Client identifier the provider expects at the token endpoint. */
  readonly clientId: string;
  /** Client secret the provider expects in the Basic authorization header. */
  readonly clientSecret: string;
  /** Exact redirect URI registered for the client. */
  readonly redirectUrl: string;
}

/** The authorization request the fake provider last received. */
export interface FakeAuthorizationRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly scope: string;
  readonly responseType: string;
}

/** Options for {@link FakeOidcProvider.issueCode}. */
export interface FakeAuthorizationCodeOptions {
  /** Nonce the signed ID token must carry. */
  readonly nonce: string;
  /** S256 challenge the token request verifier must reproduce. */
  readonly codeChallenge: string;
  /** User profile returned by the token and UserInfo endpoints. */
  readonly user: FakeOidcUser;
  /** Redirect URI bound to the code; defaults to the registered redirect URL. */
  readonly redirectUri?: string;
  /** Subject for the ID token; defaults to the user's subject. */
  readonly idTokenSubject?: string;
  /** Subject for UserInfo; defaults to the user's subject. */
  readonly userInfoSubject?: string;
}

interface AuthorizationCodeRecord {
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly user: FakeOidcUser;
  readonly idTokenSubject: string;
  readonly userInfoSubject: string;
  used: boolean;
}

/**
 * A real HTTPS OpenID Connect provider for integration tests.
 *
 * It serves discovery metadata, a JWKS document, the authorization endpoint,
 * the token endpoint, and the UserInfo endpoint. The provider validates PKCE
 * `S256`, the nonce, the redirect URI, and `client_secret_basic`; it signs ID
 * tokens with RS256 through `jose`. Tests pass {@link FakeOidcProvider.fetch}
 * to the application so `openid-client` can trust the fixture certificate
 * authority.
 *
 * The test driver normally parses the authorization URL the application
 * returns, calls {@link FakeOidcProvider.issueCode}, and sends the resulting
 * code back to the application callback. The authorization endpoint is still
 * implemented so a test can prove the provider itself accepts the request.
 *
 * @example
 * ```ts
 * const provider = await FakeOidcProvider.start({
 *   clientId: "client",
 *   clientSecret: "secret",
 *   redirectUrl: "https://vault.example.com/v1/auth/callback",
 * });
 * const code = provider.issueCode({ nonce, codeChallenge, user });
 * // Send `code` and the original state to the application callback.
 * await provider.close();
 * ```
 */
export class FakeOidcProvider {
  readonly #server: Server;
  readonly #tls: TlsFixture;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #redirectUrl: string;
  readonly #privateKey: CryptoKey;
  readonly #publicJwk: JWK;
  readonly #codes = new Map<string, AuthorizationCodeRecord>();
  readonly #accessTokens = new Map<string, string>();
  readonly #issuedTokens: string[] = [];
  #port = 0;
  #tokenRequests = 0;
  #lastAuthorization: FakeAuthorizationRequest | undefined;
  #authorizationUser: FakeOidcUser | undefined;
  #closed = false;

  private constructor(
    server: Server,
    tls: TlsFixture,
    options: FakeOidcProviderOptions,
    privateKey: CryptoKey,
    publicJwk: JWK,
  ) {
    this.#server = server;
    this.#tls = tls;
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#redirectUrl = options.redirectUrl;
    this.#privateKey = privateKey;
    this.#publicJwk = publicJwk;
    this.fetch = (input, init) => this.#send(input, init);
    server.on("request", (request, response) => {
      void this.#dispatch(request, response);
    });
  }

  /**
   * Creates a key pair, a disposable TLS server, and binds it to an ephemeral
   * loopback port.
   *
   * @param options - Client credentials and the registered redirect URI.
   * @returns A running provider; call {@link FakeOidcProvider.close} when done.
   */
  public static async start(options: FakeOidcProviderOptions): Promise<FakeOidcProvider> {
    const tls = createTlsFixture();
    try {
      const { privateKey, publicKey } = await generateKeyPair("RS256");
      const exported = await exportJWK(publicKey);
      const publicJwk: JWK = { ...exported, alg: "RS256", use: "sig", kid: KEY_ID };
      const server = createServer({
        key: tls.serverKeyPem,
        cert: tls.serverCertPem,
        minVersion: "TLSv1.2",
      });
      const provider = new FakeOidcProvider(server, tls, options, privateKey, publicJwk);
      provider.#port = await listen(server);
      return provider;
    } catch (error) {
      tls.cleanup();
      throw error;
    }
  }

  /** Issuer URL the application config and discovery metadata must agree on. */
  public get issuer(): string {
    return new URL(`https://localhost:${this.#port}`).href;
  }

  /**
   * A `fetch` implementation that trusts the fixture CA.
   *
   * `openid-client` receives this function from the test application, so every
   * discovery, JWKS, token, and UserInfo request uses the real HTTPS server.
   */
  public readonly fetch: FetchFunction;

  /**
   * Sets the profile the next authorization request provisions.
   *
   * Only the authorization endpoint consumes the value; the normal test driver
   * issues codes directly with {@link FakeOidcProvider.issueCode}.
   *
   * @param user - Profile to return for the next authorization request.
   */
  public authorizeAs(user: FakeOidcUser): void {
    this.#authorizationUser = user;
  }

  /** Returns the authorization request the provider last received, if any. */
  public lastAuthorization(): FakeAuthorizationRequest | undefined {
    return this.#lastAuthorization;
  }

  /**
   * Issues a single-use authorization code bound to a nonce, a PKCE challenge,
   * and a user profile.
   *
   * @param options - Binding values and the profile the code represents.
   * @returns The opaque authorization code to send to the application.
   */
  public issueCode(options: FakeAuthorizationCodeOptions): string {
    const code = `code_${randomBytes(24).toString("base64url")}`;
    this.#codes.set(code, {
      nonce: options.nonce,
      codeChallenge: options.codeChallenge,
      redirectUri: options.redirectUri ?? this.#redirectUrl,
      user: options.user,
      idTokenSubject: options.idTokenSubject ?? options.user.subject,
      userInfoSubject: options.userInfoSubject ?? options.user.subject,
      used: false,
    });
    return code;
  }

  /**
   * Every access, refresh, and ID token the provider has issued, in issuance
   * order.
   *
   * The non-persistence test uses these exact strings to prove none of them
   * reaches the application cache, database, or logs.
   */
  public issuedTokens(): readonly string[] {
    return [...this.#issuedTokens];
  }

  /** Number of token endpoint requests received, including rejected requests. */
  public tokenRequests(): number {
    return this.#tokenRequests;
  }

  /** Stops the HTTPS listener and removes every fixture file. */
  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
      this.#server.closeAllConnections();
    });
    this.#tls.cleanup();
  }

  async #dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      await this.#route(request, response);
    } catch {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 500, { error: "server_error" });
    }
  }

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.issuer);
    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        this.#serveDiscovery(response);
        return;
      case "/jwks":
        sendJson(response, 200, { keys: [this.#publicJwk] });
        return;
      case "/authorize":
        this.#serveAuthorize(url, response);
        return;
      case "/token":
        await this.#serveToken(request, response);
        return;
      case "/userinfo":
        this.#serveUserInfo(request, response);
        return;
      default:
        sendJson(response, 404, { error: "not_found" });
    }
  }

  #serveDiscovery(response: ServerResponse): void {
    sendJson(response, 200, {
      issuer: this.issuer,
      authorization_endpoint: this.#endpoint("/authorize"),
      token_endpoint: this.#endpoint("/token"),
      userinfo_endpoint: this.#endpoint("/userinfo"),
      jwks_uri: this.#endpoint("/jwks"),
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
    });
  }

  #serveAuthorize(url: URL, response: ServerResponse): void {
    const params = url.searchParams;
    const authorization: FakeAuthorizationRequest = {
      clientId: params.get("client_id") ?? "",
      redirectUri: params.get("redirect_uri") ?? "",
      state: params.get("state") ?? "",
      nonce: params.get("nonce") ?? "",
      codeChallenge: params.get("code_challenge") ?? "",
      codeChallengeMethod: params.get("code_challenge_method") ?? "",
      scope: params.get("scope") ?? "",
      responseType: params.get("response_type") ?? "",
    };
    this.#lastAuthorization = authorization;

    const user = this.#authorizationUser;
    this.#authorizationUser = undefined;
    const valid =
      user !== undefined &&
      authorization.clientId === this.#clientId &&
      authorization.redirectUri === this.#redirectUrl &&
      authorization.responseType === "code" &&
      authorization.codeChallengeMethod === "S256" &&
      authorization.nonce.length > 0 &&
      authorization.codeChallenge.length > 0;
    if (!valid || user === undefined) {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }

    const code = this.issueCode({
      nonce: authorization.nonce,
      codeChallenge: authorization.codeChallenge,
      user,
    });
    const redirect = new URL(authorization.redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", authorization.state);
    response.writeHead(302, { location: redirect.href });
    response.end();
  }

  async #serveToken(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.#tokenRequests += 1;
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "invalid_request" });
      return;
    }
    if (!this.#hasValidClientCredentials(request.headers.authorization)) {
      sendJson(response, 401, { error: "invalid_client" });
      return;
    }

    const form = new URLSearchParams(await readBody(request));
    const code = form.get("code");
    const record = code === null ? undefined : this.#codes.get(code);
    const verifier = form.get("code_verifier");
    const valid =
      form.get("grant_type") === "authorization_code" &&
      record !== undefined &&
      !record.used &&
      form.get("redirect_uri") === record.redirectUri &&
      verifier !== null &&
      createHash("sha256").update(verifier, "utf8").digest("base64url") === record.codeChallenge;
    if (!valid || code === null || record === undefined) {
      sendJson(response, 400, { error: "invalid_grant" });
      return;
    }

    record.used = true;
    const accessToken = `access_${randomBytes(24).toString("base64url")}`;
    const refreshToken = `refresh_${randomBytes(24).toString("base64url")}`;
    const idToken = await this.#signIdToken(record);
    this.#accessTokens.set(accessToken, code);
    this.#issuedTokens.push(accessToken, refreshToken, idToken);

    sendJson(response, 200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ID_TOKEN_LIFETIME_SECONDS,
      refresh_token: refreshToken,
      id_token: idToken,
    });
  }

  #serveUserInfo(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "invalid_request" });
      return;
    }
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    const code = token === undefined ? undefined : this.#accessTokens.get(token);
    const record = code === undefined ? undefined : this.#codes.get(code);
    if (record === undefined) {
      sendJson(
        response,
        401,
        { error: "invalid_token" },
        { "www-authenticate": 'Bearer error="invalid_token"' },
      );
      return;
    }

    const body: Record<string, unknown> = {
      sub: record.userInfoSubject,
      email: record.user.email,
    };
    if (record.user.emailVerified !== undefined) {
      body.email_verified = record.user.emailVerified;
    }
    if (record.user.name !== undefined) {
      body.name = record.user.name;
    }
    sendJson(response, 200, body);
  }

  #hasValidClientCredentials(header: string | undefined): boolean {
    if (header === undefined) {
      return false;
    }
    const prefix = "basic ";
    if (!header.toLowerCase().startsWith(prefix)) {
      return false;
    }
    const encoded = header.slice(prefix.length).trim();
    if (encoded.length === 0) {
      return false;
    }
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator === -1) {
      return false;
    }
    const clientId = decodeURIComponent(decoded.slice(0, separator));
    const clientSecret = decodeURIComponent(decoded.slice(separator + 1));
    return clientId === this.#clientId && clientSecret === this.#clientSecret;
  }

  #signIdToken(record: AuthorizationCodeRecord): Promise<string> {
    const issuedAt = Math.floor(Date.now() / 1_000);
    return new SignJWT({ nonce: record.nonce })
      .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
      .setIssuer(this.issuer)
      .setAudience(this.#clientId)
      .setSubject(record.idTokenSubject)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ID_TOKEN_LIFETIME_SECONDS)
      .sign(this.#privateKey);
  }

  #endpoint(path: string): string {
    return new URL(path, this.issuer).href;
  }

  #send(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const url = toUrl(input);
      const headers = new Headers(init?.headers);
      const body = serializeBody(init?.body);
      if (body !== undefined && !headers.has("content-length")) {
        headers.set("content-length", String(body.length));
      }

      const request = httpsRequest(
        {
          host: "127.0.0.1",
          port: this.#port,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          headers: Object.fromEntries(headers.entries()),
          ca: this.#tls.caPem,
          servername: "localhost",
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          response.on("end", () => {
            resolve(
              new Response(chunks.length === 0 ? null : Buffer.concat(chunks), {
                status: response.statusCode ?? 500,
                headers: toHeaders(response.headers),
              }),
            );
          });
          response.on("error", reject);
        },
      );

      const signal = init?.signal;
      if (signal !== null && signal !== undefined) {
        const abort = (): void => {
          request.destroy(new Error("the fake provider fetch request was aborted"));
        };
        if (signal.aborted) {
          abort();
        } else {
          signal.addEventListener("abort", abort, { once: true });
        }
      }

      request.on("error", reject);
      if (body !== undefined) {
        request.write(body);
      }
      request.end();
    });
  }
}

/**
 * Starts a keyless HTTPS listener on an ephemeral loopback port.
 *
 * @param server - HTTPS server with a fixture certificate.
 * @returns The bound port.
 */
function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("the fake OIDC provider did not expose a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

/** Converts the several `fetch` input shapes into one URL. */
function toUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

/** Converts a WHATWG request body into bytes for `node:https`. */
function serializeBody(body: RequestInit["body"]): Buffer | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString(), "utf8");
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error("the fake OIDC provider fetch does not support this request body");
}

/** Copies Node response headers into a WHATWG `Headers` object. */
function toHeaders(source: IncomingMessage["headers"]): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(name, entry);
      }
      continue;
    }
    headers.set(name, value);
  }
  return headers;
}

/** Reads a complete request body as UTF-8 text. */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

/** Writes one JSON response. */
function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}
