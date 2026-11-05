import { request as httpsRequest } from "node:https";
import type {
  AgentCertificateResponse,
  AgentConsumerState,
  SecretValueResponse,
} from "@openvault/api-contract";
import {
  agentCertificateResponseSchema,
  agentConsumerStateResponseSchema,
  secretValueResponseSchema,
} from "@openvault/api-contract";

/** Client error kind used by the delivery and renewal state machines. */
export type VaultErrorKind =
  | "credential"
  | "transient"
  | "not_found"
  | "terminal"
  | "renewal_not_due"
  | "renewal_not_current";

/** A classified vault request failure. */
export class VaultClientError extends Error {
  /**
   * @param kind - Retry/terminal classification.
   * @param message - Short static message.
   * @param options - HTTP status, stable server code, and cause.
   */
  public constructor(
    public readonly kind: VaultErrorKind,
    message: string,
    options: { readonly status?: number; readonly code?: string; readonly cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "VaultClientError";
    this.status = options.status;
    this.code = options.code;
  }

  /** HTTP status when a response was received. */
  public readonly status: number | undefined;
  /** Stable server error code when one was returned. */
  public readonly code: string | undefined;
}

/** Options for {@link VaultClient}. */
export interface VaultClientOptions {
  /** Agent listener origin. */
  readonly baseUrl: URL;
  /** PEM bundle used to verify the server. */
  readonly caPem: string;
  /** Total request timeout. */
  readonly timeoutMs?: number;
  /** Maximum response body. */
  readonly maxResponseBytes?: number;
}

/** Identity material used for mTLS. */
export interface ClientIdentity {
  /** Leaf certificate PEM. */
  readonly certificatePem: string;
  /** PKCS#8 private key PEM. */
  readonly privateKeyPem: string;
}

/** One raw response. */
interface RawResponse {
  readonly status: number;
  readonly body: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_REQUEST_BYTES = 65_536;
const TLS_PREFIXES = ["ERR_TLS_", "ERR_SSL_", "CERT_", "UNABLE_TO_"];
const TLS_EXACT = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "HOSTNAME_MISMATCH",
]);

/** Returns true for a TLS certificate/handshake failure. */
function isTlsFailure(code: string | undefined): boolean {
  if (code === undefined) {
    return false;
  }
  return TLS_EXACT.has(code) || TLS_PREFIXES.some((prefix) => code.startsWith(prefix));
}

/** Returns true for a network/socket failure that should be retried. */
function isNetworkFailure(code: string | undefined): boolean {
  return code !== undefined && /^E[A-Z0-9_]+$/.test(code);
}

/** Parses a JSON body or throws a terminal client error. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new VaultClientError("terminal", "Vault returned a malformed response");
  }
}

/** Reads the stable server error code from an envelope. */
function serverErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const error = Reflect.get(parsed, "error");
    if (typeof error !== "object" || error === null) {
      return undefined;
    }
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * HTTPS client for the agent listener.
 *
 * The client uses a pinned CA bundle, optional client certificate, TLS 1.2+,
 * hostname verification, bounded request/response bodies, and no redirects.
 * It classifies every response and transport failure so the caller can apply
 * the RD-10 failure matrix without inspecting raw errors.
 */
export class VaultClient {
  readonly #baseUrl: URL;
  readonly #caPem: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  /**
   * @param options - Origin, CA PEM, and bounds.
   */
  public constructor(options: VaultClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#caPem = options.caPem;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  }

  /**
   * Joins one service identity.
   *
   * @param body - Token, CSR, and consumer metadata.
   * @returns The issued certificate material.
   */
  public async join(body: unknown): Promise<AgentCertificateResponse> {
    const response = await this.#request("POST", "/v1/agent/join", body);
    return this.#parse(agentCertificateResponseSchema, response.body);
  }

  /**
   * Renews the current identity.
   *
   * @param identity - Current certificate and key.
   * @param body - CSR and consumer metadata.
   * @returns The issued certificate material.
   */
  public async renew(identity: ClientIdentity, body: unknown): Promise<AgentCertificateResponse> {
    const response = await this.#request("POST", "/v1/agent/renew", body, identity);
    return this.#parse(agentCertificateResponseSchema, response.body);
  }

  /**
   * Reads one manifest secret.
   *
   * @param project - Project name.
   * @param name - Secret name.
   * @param identity - Current certificate and key.
   * @param state - Aggregate state before this entry.
   * @param optional - Whether the entry is optional.
   * @returns The value response.
   */
  public async readSecret(
    project: string,
    name: string,
    identity: ClientIdentity,
    state: AgentConsumerState,
    optional: boolean,
  ): Promise<SecretValueResponse> {
    const path = `/v1/data/${encodeURIComponent(project)}/secrets/${encodeURIComponent(name)}`;
    const response = await this.#request("GET", path, undefined, identity, {
      "X-OpenVault-Consumer-State": state,
      "X-OpenVault-Entry-Optional": optional ? "true" : "false",
    });
    return this.#parse(secretValueResponseSchema, response.body);
  }

  /**
   * Sends the aggregate consumer heartbeat.
   *
   * @param identity - Current certificate and key.
   * @param state - Aggregate delivery state.
   */
  public async heartbeat(identity: ClientIdentity, state: AgentConsumerState): Promise<void> {
    const response = await this.#request("POST", "/v1/agent/consumer", { state }, identity);
    this.#parse(agentConsumerStateResponseSchema, response.body);
  }

  /** Parses a successful body with the shared contract schema. */
  #parse<T>(
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    body: string,
  ): T {
    const parsed = schema.safeParse(parseJson(body));
    if (!parsed.success) {
      throw new VaultClientError("terminal", "Vault response did not match the contract");
    }
    return parsed.data;
  }

  /** Runs one request and maps its status. */
  async #request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    identity?: ClientIdentity,
    extraHeaders: Record<string, string> = {},
  ): Promise<RawResponse> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    if (payload !== undefined && payload.length > MAX_REQUEST_BYTES) {
      throw new VaultClientError("terminal", "Request body exceeds the agent limit");
    }
    return await new Promise<RawResponse>((resolve, reject) => {
      const request = httpsRequest(
        {
          protocol: this.#baseUrl.protocol,
          hostname: this.#baseUrl.hostname,
          port: this.#baseUrl.port,
          path,
          method,
          ca: this.#caPem,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          servername: this.#baseUrl.hostname,
          timeout: this.#timeoutMs,
          headers: {
            Accept: "application/json",
            ...(payload === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "Content-Length": String(payload.length),
                }),
            ...extraHeaders,
          },
          ...(identity === undefined
            ? {}
            : { cert: identity.certificatePem, key: identity.privateKeyPem }),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > this.#maxResponseBytes) {
              response.destroy();
              reject(new VaultClientError("terminal", "Vault response exceeds the agent limit"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            const text = Buffer.concat(chunks).toString("utf8");
            try {
              this.#assertStatus(status, text);
              resolve({ status, body: text });
            } catch (error) {
              reject(error);
            }
          });
          response.on("error", (error) => {
            reject(this.#classifyTransport(error));
          });
        },
      );
      request.on("timeout", () => {
        request.destroy(new Error("request timeout"));
      });
      request.on("error", (error) => {
        reject(this.#classifyTransport(error));
      });
      if (payload !== undefined) {
        request.write(payload);
      }
      request.end();
    });
  }

  /** Maps an HTTP status to a client error. */
  #assertStatus(status: number, body: string): void {
    if (status >= 200 && status < 300) {
      return;
    }
    const code = serverErrorCode(body);
    if (status === 401 || status === 403) {
      throw new VaultClientError("credential", "Vault rejected the agent credential", {
        status,
        ...(code === undefined ? {} : { code }),
      });
    }
    if (status === 404 || status === 410) {
      throw new VaultClientError("not_found", "Vault resource was not found", {
        status,
        ...(code === undefined ? {} : { code }),
      });
    }
    if (status === 409 && code === "renewal_not_due") {
      throw new VaultClientError("renewal_not_due", "Renewal is not due", { status, code });
    }
    if (status === 409 && code === "renewal_not_current") {
      throw new VaultClientError("renewal_not_current", "Another certificate is current", {
        status,
        code,
      });
    }
    if (status === 429 || status >= 500) {
      throw new VaultClientError("transient", "Vault is temporarily unavailable", {
        status,
        ...(code === undefined ? {} : { code }),
      });
    }
    throw new VaultClientError("terminal", "Vault rejected the request", {
      status,
      ...(code === undefined ? {} : { code }),
    });
  }

  /** Maps a transport error to a client error. */
  #classifyTransport(error: unknown): VaultClientError | Error {
    const code =
      typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
        ? String(Reflect.get(error, "code"))
        : undefined;
    if (isTlsFailure(code)) {
      return new VaultClientError("credential", "Vault TLS certificate was rejected", {
        ...(code === undefined ? {} : { code }),
        cause: error,
      });
    }
    if (isNetworkFailure(code) || (error instanceof Error && error.message === "request timeout")) {
      return new VaultClientError("transient", "Vault connection failed", {
        ...(code === undefined ? {} : { code }),
        cause: error,
      });
    }
    return new VaultClientError("terminal", "Vault request failed", {
      ...(code === undefined ? {} : { code }),
      cause: error,
    });
  }
}
