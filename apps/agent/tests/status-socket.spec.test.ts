import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DeliveredEntry } from "../src/delivery.js";
import { silentAgentLogger } from "../src/logger.js";
import { startLocalSocket } from "../src/socket.js";
import { readHealth, type StatusDocument } from "../src/status.js";

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openvault-agent-status-"));
  directories.push(directory);
  return directory;
}

function statusDocument(overrides: Partial<StatusDocument> = {}): StatusDocument {
  return {
    version: 1,
    state: "ok",
    requiredReady: true,
    project: "payments",
    service: "api",
    manifestHash: `sha256:${"a".repeat(64)}`,
    identityId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    certificateNotAfter: new Date(Date.now() + 86_400_000).toISOString(),
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    refreshMs: 300_000,
    staleAfterMs: 960_000,
    renewal: {
      state: "ok",
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextAttemptAt: null,
    },
    entries: [
      {
        name: "db-password",
        required: true,
        state: "ok",
        versionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        updatedAt: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

function socketRequest(
  socketPath: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("status and local socket", () => {
  it("should report ok, degraded, failed, and missing states", () => {
    const directory = tempDirectory();
    const path = join(directory, "status.json");
    writeFileSync(path, JSON.stringify(statusDocument()));
    chmodSync(path, 0o600);
    expect(readHealth(path)).toEqual({ state: "ok", exitCode: 0 });
    writeFileSync(path, JSON.stringify(statusDocument({ state: "degraded" })));
    expect(readHealth(path)).toEqual({ state: "degraded", exitCode: 1 });
    writeFileSync(path, JSON.stringify(statusDocument({ state: "failed" })));
    expect(readHealth(path)).toEqual({ state: "failed", exitCode: 2 });
    expect(readHealth(join(directory, "missing.json"))).toEqual({
      state: "failed",
      exitCode: 2,
    });
  });

  it("should use required readiness for the Compose gate", () => {
    const directory = tempDirectory();
    const path = join(directory, "status.json");
    writeFileSync(path, JSON.stringify(statusDocument({ state: "degraded", requiredReady: true })));
    expect(readHealth(path, { ready: true })).toEqual({ state: "degraded", exitCode: 0 });
    writeFileSync(path, JSON.stringify(statusDocument({ state: "failed", requiredReady: false })));
    expect(readHealth(path, { ready: true })).toEqual({ state: "failed", exitCode: 2 });
  });

  it("should treat a stale status as failed", () => {
    const directory = tempDirectory();
    const path = join(directory, "status.json");
    const old = new Date(Date.now() - 2_000_000).toISOString();
    writeFileSync(path, JSON.stringify(statusDocument({ lastAttemptAt: old })));
    expect(readHealth(path)).toEqual({ state: "failed", exitCode: 2 });
  });

  it("should serve only manifest entries and a value-free status", async () => {
    const directory = tempDirectory();
    const socketPath = join(directory, "agent.sock");
    const delivered: DeliveredEntry = {
      name: "db-password",
      value: Buffer.from("secret-value"),
      encoding: "utf8",
      versionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      deliveredAt: new Date(),
      required: true,
      entry: { name: "db-password", files: [], env: [], optional: false },
      envError: false,
    };
    const handle = await startLocalSocket({
      path: socketPath,
      getSecret: (name) => (name === "db-password" ? delivered : undefined),
      getStatus: () => statusDocument(),
      logger: silentAgentLogger,
    });
    try {
      expect(statSync(socketPath).mode & 0o777).toBe(0o660);
      const found = await socketRequest(socketPath, "/v1/secrets/db-password");
      expect(found.status).toBe(200);
      expect(JSON.parse(found.body)).toMatchObject({
        name: "db-password",
        value: "secret-value",
        encoding: "utf8",
      });
      const unknown = await socketRequest(socketPath, "/v1/secrets/other");
      expect(unknown.status).toBe(404);
      const status = await socketRequest(socketPath, "/v1/status");
      expect(status.status).toBe(200);
      expect(status.body).not.toContain("secret-value");
    } finally {
      await handle.close();
    }
  });
});
