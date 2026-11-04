import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One captured webhook request. */
export interface CapturedWebhook {
  /** Request headers. */
  readonly headers: Record<string, string | string[] | undefined>;
  /** Raw request body. */
  readonly body: string;
}

/** A local webhook server used by expiry tests. */
export interface TestWebhook {
  /** Absolute URL. */
  readonly url: string;
  /** Captured requests. */
  readonly requests: CapturedWebhook[];
  /** Sets the response status for subsequent requests. */
  setStatus(status: number): void;
  /** Closes the server. */
  close(): Promise<void>;
}

/**
 * Starts a local HTTP webhook receiver.
 *
 * @returns The URL, captured requests, status control, and close function.
 */
export async function startTestWebhook(): Promise<TestWebhook> {
  const requests: CapturedWebhook[] = [];
  let status = 200;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.statusCode = status;
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/expiry`,
    requests,
    setStatus(value: number): void {
      status = value;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}
