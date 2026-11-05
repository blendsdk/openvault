import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import type { AdapterRequest, AdapterResponse, RequestAdapter } from "blendsdk/api-client";
import { CliError, exitCodeForStatus } from "../errors.js";

/** One value-free request event for verbose output. */
export interface RequestEvent {
  /** HTTP method. */
  readonly method: string;
  /** Request path without the query string. */
  readonly path: string;
  /** Response status, or 0 when no response was received. */
  readonly status: number;
  /** Server request id, when present. */
  readonly requestId?: string;
  /** Elapsed milliseconds. */
  readonly durationMs: number;
}

/** Options for {@link HttpsAdapter}. */
export interface HttpsAdapterOptions {
  /** Server origin. */
  readonly baseUrl: string;
  /** Optional CA bundle. */
  readonly caPem?: string;
  /** Total request timeout. */
  readonly timeoutMs?: number;
  /** Explicit TLS SNI name. */
  readonly servername?: string;
  /** Maximum buffered JSON response. */
  readonly maxJsonBytes?: number;
  /** Receives one value-free event per request. */
  readonly onRequest?: (event: RequestEvent) => void;
}

/** One raw buffered response. */
interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** A probe response with headers. */
export interface ProbeResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

/** Options for {@link HttpsAdapter.download}. */
export interface DownloadOptions {
  /** Explicit request headers, including the bearer token. */
  readonly headers?: Record<string, string>;
  /** Replace an existing target. */
  readonly force?: boolean;
  /** Refreshes the bearer header after one 401 response. */
  readonly onUnauthorized?: () => Promise<Record<string, string>>;
}

/** One non-2xx or wrong-content-type export response. */
class ExportRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly headers: IncomingHttpHeaders,
    public readonly body: string,
  ) {
    super(`Export failed with status ${status}`);
    this.name = "ExportRequestError";
  }
}

/** Converts one export response failure into a stable CLI error. */
function exportError(error: ExportRequestError): CliError {
  let code = "request_failed";
  let message = `The export failed with status ${error.status}`;
  let requestId: string | undefined;
  if (error.status >= 200 && error.status < 300) {
    message = "The export response was not NDJSON";
  }
  try {
    const parsed = JSON.parse(error.body) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const envelope = Reflect.get(parsed, "error");
      if (typeof envelope === "object" && envelope !== null) {
        const candidate = Reflect.get(envelope, "code");
        const candidateMessage = Reflect.get(envelope, "message");
        const candidateRequest = Reflect.get(envelope, "requestId");
        if (typeof candidate === "string" && candidate.length > 0) {
          code = candidate;
        }
        if (typeof candidateMessage === "string" && candidateMessage.length > 0) {
          message = candidateMessage;
        }
        if (typeof candidateRequest === "string") {
          requestId = candidateRequest;
        }
      }
    }
  } catch {
    // A non-JSON error body keeps the generic message.
  }
  return new CliError(code, message, {
    exitCode: exitCodeForStatus(error.status),
    ...(requestId === undefined ? {} : { requestId }),
  });
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_JSON_BYTES = 1_048_576;
const MAX_EXPORT_BYTES = 104_857_600;

/** Returns one header value as a string. */
function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

/** Parses a Retry-After header into milliseconds, capped at five seconds. */
function retryAfterMs(headers: IncomingHttpHeaders): number {
  const value = headerValue(headers, "retry-after");
  if (value === undefined) {
    return 1_000;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, 5_000);
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(date - Date.now(), 0), 5_000);
  }
  return 1_000;
}

/** Parses one response body using its content type. */
function parseBody(contentType: string | undefined, body: Buffer): unknown {
  if (body.length === 0) {
    return undefined;
  }
  const text = body.toString("utf8");
  if (contentType?.toLowerCase().includes("application/json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * HTTPS transport for the generated client and CLI-only raw operations.
 *
 * It pins the CA when provided, verifies the hostname, uses TLS 1.2+, follows no
 * redirects, bounds JSON responses, and performs the single 429 retry because
 * only this layer sees `Retry-After`.
 */
export class HttpsAdapter implements RequestAdapter {
  readonly #baseUrl: URL;
  readonly #caPem: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxJsonBytes: number;
  readonly #servername: string | undefined;
  readonly #onRequest: ((event: RequestEvent) => void) | undefined;

  /**
   * @param options - Origin, CA, timeout, and bound.
   */
  public constructor(options: HttpsAdapterOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    this.#caPem = options.caPem;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxJsonBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
    this.#servername =
      options.servername ??
      (isIP(this.#baseUrl.hostname) === 0 ? this.#baseUrl.hostname : undefined);
    this.#onRequest = options.onRequest;
  }

  /** @inheritDoc */
  public async send(request: AdapterRequest): Promise<AdapterResponse> {
    const raw = await this.#withRetry(
      request.method,
      request.url,
      request.headers,
      request.body,
      request.signal,
      this.#maxJsonBytes,
    );
    return {
      status: raw.status,
      ok: raw.status >= 200 && raw.status < 300,
      body: parseBody(headerValue(raw.headers, "content-type"), raw.body),
    };
  }

  /**
   * Performs one GET and returns headers for diagnostics.
   *
   * @param path - Absolute URL or path.
   * @param headers - Explicit headers.
   * @returns Status, headers, and parsed body.
   */
  public async probe(path: string, headers: Record<string, string> = {}): Promise<ProbeResponse> {
    const raw = await this.#once(
      "GET",
      this.#resolve(path),
      { accept: "application/json", ...headers },
      undefined,
      undefined,
      this.#maxJsonBytes,
    );
    return {
      status: raw.status,
      ok: raw.status >= 200 && raw.status < 300,
      headers: raw.headers,
      body: parseBody(headerValue(raw.headers, "content-type"), raw.body),
    };
  }

  /**
   * Streams one NDJSON export to a private file.
   *
   * @param path - Absolute URL or path.
   * @param target - Final file path.
   * @param options - Headers and overwrite policy.
   * @returns Bytes written.
   */
  public async download(
    path: string,
    target: string,
    options: DownloadOptions = {},
  ): Promise<{ readonly bytes: number }> {
    const existing = lstatIfExists(target);
    if (existing !== undefined) {
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new CliError("file_exists", "The output path must be a regular file", {
          exitCode: 1,
        });
      }
      if (options.force !== true) {
        throw new CliError("file_exists", "The output file already exists; use --force");
      }
    }
    const directory = dirname(target);
    let headers: Record<string, string> = {
      accept: "application/x-ndjson",
      ...(options.headers ?? {}),
    };
    let retriedAuth = false;
    let retriedRateLimit = false;
    for (;;) {
      const temporary = resolve(
        directory,
        `.openvault-export-${randomBytes(8).toString("hex")}.tmp`,
      );
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        const bytes = await this.#stream(this.#resolve(path), headers, descriptor);
        fsyncSync(descriptor);
        closeSync(descriptor);
        renameSync(temporary, target);
        return { bytes };
      } catch (error) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the original failure.
        }
        rmSync(temporary, { force: true });
        if (error instanceof ExportRequestError) {
          if (error.status === 401 && options.onUnauthorized !== undefined && !retriedAuth) {
            retriedAuth = true;
            headers = { accept: "application/x-ndjson", ...(await options.onUnauthorized()) };
            continue;
          }
          if (error.status === 429 && !retriedRateLimit) {
            retriedRateLimit = true;
            await new Promise<void>((resolveDelay) => {
              setTimeout(resolveDelay, retryAfterMs(error.headers));
            });
            continue;
          }
          throw exportError(error);
        }
        throw error;
      }
    }
  }

  /** Emits one verbose event when a callback is installed. */
  #observe(
    method: string,
    url: URL,
    status: number,
    headers: IncomingHttpHeaders,
    startedAt: number,
  ): void {
    if (this.#onRequest === undefined) {
      return;
    }
    const requestId = headerValue(headers, "x-request-id");
    this.#onRequest({
      method,
      path: url.pathname,
      status,
      ...(requestId === undefined ? {} : { requestId }),
      durationMs: Date.now() - startedAt,
    });
  }

  /** Resolves a path against the base URL. */
  #resolve(path: string): string {
    return new URL(path, this.#baseUrl).href;
  }

  /** Runs one request with at most one 429 retry. */
  async #withRetry(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<RawResponse> {
    const first = await this.#once(method, url, headers, body, signal, maxBytes);
    if (first.status !== 429) {
      return first;
    }
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, retryAfterMs(first.headers));
    });
    return await this.#once(method, url, headers, body, signal, maxBytes);
  }

  /** Runs one buffered request. */
  async #once(
    method: string,
    target: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<RawResponse> {
    const url = new URL(target);
    const startedAt = Date.now();
    return await new Promise<RawResponse>((resolveResponse, reject) => {
      let reported = false;
      const report = (status: number, headers: IncomingHttpHeaders): void => {
        if (reported) {
          return;
        }
        reported = true;
        this.#observe(method, url, status, headers, startedAt);
      };
      const request = httpsRequest(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method,
          headers,
          ca: this.#caPem,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          ...(this.#servername === undefined ? {} : { servername: this.#servername }),
          timeout: this.#timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
              response.destroy();
              reject(new Error("response_too_large"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            report(response.statusCode ?? 0, response.headers);
            resolveResponse({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            });
          });
          response.on("error", (error) => {
            report(0, {});
            reject(error);
          });
        },
      );
      request.on("timeout", () => {
        request.destroy(new Error("request_timeout"));
      });
      request.on("error", (error) => {
        report(0, {});
        reject(error);
      });
      const abort = (): void => {
        request.destroy(new Error("request_aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      request.on("close", () => {
        signal?.removeEventListener("abort", abort);
      });
      if (body !== undefined) {
        request.write(body);
      }
      request.end();
    });
  }

  /** Streams one request body to a file descriptor. */
  async #stream(
    target: string,
    headers: Record<string, string>,
    descriptor: number,
  ): Promise<number> {
    const url = new URL(target);
    const startedAt = Date.now();
    return await new Promise<number>((resolveStream, reject) => {
      let reported = false;
      const report = (status: number, headers: IncomingHttpHeaders): void => {
        if (reported) {
          return;
        }
        reported = true;
        this.#observe("GET", url, status, headers, startedAt);
      };
      const request = httpsRequest(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers,
          ca: this.#caPem,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          ...(this.#servername === undefined ? {} : { servername: this.#servername }),
          timeout: this.#timeoutMs,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const contentType = headerValue(response.headers, "content-type") ?? "";
          if (
            status < 200 ||
            status >= 300 ||
            !contentType.toLowerCase().includes("application/x-ndjson")
          ) {
            const chunks: Buffer[] = [];
            let total = 0;
            response.on("data", (chunk: Buffer) => {
              if (total < 65_536) {
                chunks.push(chunk);
              }
              total += chunk.length;
            });
            response.on("end", () => {
              report(status, response.headers);
              reject(
                new ExportRequestError(
                  status,
                  response.headers,
                  Buffer.concat(chunks).toString("utf8"),
                ),
              );
            });
            response.on("error", (error) => {
              report(status, response.headers);
              reject(error);
            });
            return;
          }
          let total = 0;
          response.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_EXPORT_BYTES) {
              report(status, response.headers);
              response.destroy();
              reject(new Error("response_too_large"));
              return;
            }
            try {
              const written = writeSync(descriptor, chunk);
              if (written !== chunk.length) {
                throw new Error("export_write_short");
              }
            } catch (error) {
              report(status, response.headers);
              response.destroy();
              reject(error);
            }
          });
          response.on("end", () => {
            report(status, response.headers);
            resolveStream(total);
          });
          response.on("error", (error) => {
            report(status, response.headers);
            reject(error);
          });
        },
      );
      request.on("timeout", () => {
        request.destroy(new Error("request_timeout"));
      });
      request.on("error", (error) => {
        report(0, {});
        reject(error);
      });
      request.end();
    });
  }
}

/** Returns `lstat` or undefined when absent. */
function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      return undefined;
    }
    throw new CliError("file_exists", "The output path could not be inspected");
  }
}
