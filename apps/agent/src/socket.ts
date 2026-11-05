import { chmodSync, lstatSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import type { DeliveredEntry } from "./delivery.js";
import { ensureSecureDirectory } from "./fs-utils.js";
import type { AgentLogger } from "./logger.js";
import type { StatusDocument } from "./status.js";

/** Options for {@link startLocalSocket}. */
export interface LocalSocketOptions {
  /** Absolute unix socket path. */
  readonly path: string;
  /** Returns the last delivered entry for a manifest name. */
  readonly getSecret: (name: string) => DeliveredEntry | undefined;
  /** Returns the value-free status document. */
  readonly getStatus: () => StatusDocument;
  /** Structured logger. */
  readonly logger: AgentLogger;
}

/** A running local socket. */
export interface LocalSocketHandle {
  /** Stops the server and removes the socket file. */
  close(): Promise<void>;
}

/** Writes one JSON response. */
function respond(
  statusCode: number,
  body: unknown,
  response: import("node:http").ServerResponse,
): void {
  const text = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  response.end(text);
}

/**
 * Starts the read-only unix-socket API.
 *
 * The server answers only from memory. It serves a delivered manifest entry at
 * `/v1/secrets/:name` and the value-free status at `/v1/status`; every other
 * path or method returns 404.
 *
 * @param options - Socket path, memory readers, and logger.
 * @returns A handle that stops the server.
 */
export async function startLocalSocket(options: LocalSocketOptions): Promise<LocalSocketHandle> {
  const directory = dirname(options.path);
  ensureSecureDirectory(directory, "agent_config_invalid");
  try {
    const stat = lstatSync(options.path);
    if (!stat.isSocket()) {
      throw new Error("existing path is not a socket");
    }
    rmSync(options.path, { force: true });
  } catch (error) {
    if (typeof error !== "object" || error === null || Reflect.get(error, "code") !== "ENOENT") {
      if (error instanceof Error && error.message === "existing path is not a socket") {
        throw error;
      }
    }
  }

  const server: Server = createServer((request, response) => {
    if (request.method !== "GET") {
      respond(404, { success: false }, response);
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/v1/status") {
      respond(200, options.getStatus(), response);
      return;
    }
    const prefix = "/v1/secrets/";
    if (!url.pathname.startsWith(prefix)) {
      respond(404, { success: false }, response);
      return;
    }
    let name: string;
    try {
      name = decodeURIComponent(url.pathname.slice(prefix.length));
    } catch {
      respond(404, { success: false }, response);
      return;
    }
    const entry = options.getSecret(name);
    if (entry === undefined) {
      respond(404, { success: false }, response);
      return;
    }
    respond(
      200,
      {
        name: entry.name,
        value:
          entry.encoding === "base64"
            ? entry.value.toString("base64")
            : entry.value.toString("utf8"),
        encoding: entry.encoding,
        versionId: entry.versionId,
        deliveredAt: entry.deliveredAt.toISOString(),
      },
      response,
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.path, () => resolve());
  });
  try {
    chmodSync(options.path, 0o660);
  } catch {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("local socket could not be secured");
  }
  options.logger.info("agent_socket_ready", { path: options.path });

  return {
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(options.path, { force: true });
    },
  };
}
