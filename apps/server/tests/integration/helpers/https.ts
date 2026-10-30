import type { IncomingHttpHeaders } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** Options for one test request against a bound listener. */
export interface TestRequestOptions {
  readonly port: number;
  readonly path: string;
  /** Destination address; defaults to 127.0.0.1. */
  readonly host?: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | Buffer;
  /** Trusted CA PEM. Omit for a plaintext request. */
  readonly ca?: string;
  /** Client certificate PEM for an mTLS listener. */
  readonly cert?: string;
  /** Client private key PEM for an mTLS listener. */
  readonly key?: string;
  readonly servername?: string;
  readonly plaintext?: boolean;
  /** Send the body without a Content-Length header. */
  readonly chunked?: boolean;
}

/** A response captured by the test helper. */
export interface TestResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  readonly json: unknown;
}

/**
 * Sends one HTTP or HTTPS request to 127.0.0.1.
 *
 * The helper rejects on transport failures, so a test can assert that a
 * plaintext or untrusted connection cannot complete.
 */
export function testRequest(options: TestRequestOptions): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : Buffer.from(options.body);
    const headers = { ...options.headers };
    if (body !== undefined && !options.chunked && headers["content-length"] === undefined) {
      headers["content-length"] = String(body.length);
    }

    const baseOptions = {
      host: options.host ?? "127.0.0.1",
      port: options.port,
      path: options.path,
      method: options.method ?? "GET",
      headers,
    };

    const onResponse = (response: import("node:http").IncomingMessage): void => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: text,
          json,
        });
      });
    };

    const request = options.plaintext
      ? httpRequest(baseOptions, onResponse)
      : httpsRequest(
          {
            ...baseOptions,
            ...(options.ca === undefined ? {} : { ca: options.ca }),
            ...(options.cert === undefined ? {} : { cert: options.cert }),
            ...(options.key === undefined ? {} : { key: options.key }),
            ...(options.servername === undefined ? {} : { servername: options.servername }),
          },
          onResponse,
        );

    request.on("error", reject);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}
