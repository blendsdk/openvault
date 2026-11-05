import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpsAdapter } from "../src/transport/https-adapter.js";
import { createTestTls, type TestTls } from "./helpers/tls.js";

let tls: TestTls;
let server: Server;
let baseUrl: string;
const directories: string[] = [];
let tooManyRequests = 0;

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openvault-cli-transport-"));
  directories.push(directory);
  return directory;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(body);
}

beforeAll(async () => {
  tls = await createTestTls();
  server = createServer({ key: tls.keyPem, cert: tls.certPem }, (request, response) => {
    const url = new URL(request.url ?? "/", "https://localhost");
    if (url.pathname === "/ok") {
      json(response, 200, { success: true, data: { ok: true } });
      return;
    }
    if (url.pathname === "/slow") {
      setTimeout(() => json(response, 200, { success: true, data: {} }), 300);
      return;
    }
    if (url.pathname === "/large") {
      json(response, 200, { data: "x".repeat(200) });
      return;
    }
    if (url.pathname === "/redirect") {
      response.writeHead(302, { Location: "/ok" });
      response.end();
      return;
    }
    if (url.pathname === "/html-error") {
      response.writeHead(500, { "Content-Type": "text/html" });
      response.end("<html>proxy error</html>");
      return;
    }
    if (url.pathname === "/retry") {
      tooManyRequests += 1;
      if (tooManyRequests === 1) {
        response.writeHead(429, { "Retry-After": "0" });
        response.end();
        return;
      }
      json(response, 200, { success: true, data: { retried: true } });
      return;
    }
    if (url.pathname === "/headers") {
      json(response, 200, { authorization: request.headers.authorization ?? null });
      return;
    }
    if (url.pathname === "/export") {
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      response.end('{"eventId":"one"}\n{"eventId":"two"}\n');
      return;
    }
    if (url.pathname === "/export-bad") {
      json(response, 403, { success: false, error: { code: "forbidden" } });
      return;
    }
    json(response, 404, { success: false, error: { code: "not_found" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("transport test server did not bind");
  }
  baseUrl = `https://localhost:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  tls.cleanup();
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("HTTPS adapter", () => {
  it("should send a request through a trusted CA", async () => {
    const adapter = new HttpsAdapter({ baseUrl, caPem: tls.caPem });
    const response = await adapter.send({
      url: `${baseUrl}/ok`,
      method: "GET",
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(response.body).toEqual({ success: true, data: { ok: true } });
  });

  it("should reject an untrusted certificate", async () => {
    const adapter = new HttpsAdapter({ baseUrl });
    await expect(
      adapter.send({ url: `${baseUrl}/ok`, method: "GET", headers: {} }),
    ).rejects.toThrow();
  });

  it("should time out a slow response", async () => {
    const adapter = new HttpsAdapter({ baseUrl, caPem: tls.caPem, timeoutMs: 80 });
    await expect(
      adapter.send({ url: `${baseUrl}/slow`, method: "GET", headers: {} }),
    ).rejects.toThrow(/timeout/i);
  });

  it("should reject a response over the JSON bound", async () => {
    const adapter = new HttpsAdapter({ baseUrl, caPem: tls.caPem, maxJsonBytes: 32 });
    await expect(
      adapter.send({ url: `${baseUrl}/large`, method: "GET", headers: {} }),
    ).rejects.toThrow(/too_large/);
  });

  it("should not follow a redirect", async () => {
    const adapter = new HttpsAdapter({ baseUrl, caPem: tls.caPem });
    const response = await adapter.send({
      url: `${baseUrl}/redirect`,
      method: "GET",
      headers: {},
    });
    expect(response.status).toBe(302);
    expect(response.ok).toBe(false);
  });

  it("should keep a non-JSON error body as text", async () => {
    const adapter = new HttpsAdapter({ baseUrl, caPem: tls.caPem });
    const response = await adapter.send({
      url: `${baseUrl}/html-error`,
      method: "GET",
      headers: {},
    });
    expect(response.status).toBe(500);
    expect(response.body).toContain("proxy error");
  });

  it("should retry a 429 once when Retry-After is present", async () => {
    tooManyRequests = 0;
    const adapter = new HttpsAdapter({ baseUrl, caPem: tls.caPem });
    const response = await adapter.send({
      url: `${baseUrl}/retry`,
      method: "GET",
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(tooManyRequests).toBe(2);
  });

  it("should pass explicit probe headers and return response headers", async () => {
    const adapter = new HttpsAdapter({ baseUrl, caPem: tls.caPem });
    const response = await adapter.probe("/headers", { Authorization: "Bearer token" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ authorization: "Bearer token" });
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("should stream NDJSON to a 0600 file and preserve an existing target on failure", async () => {
    const adapter = new HttpsAdapter({ baseUrl, caPem: tls.caPem });
    const directory = tempDirectory();
    const target = join(directory, "audit.ndjson");
    const result = await adapter.download("/export", target);
    expect(result.bytes).toBeGreaterThan(0);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toContain('"eventId":"two"');

    writeFileSync(target, "original\n", "utf8");
    await expect(adapter.download("/export", target)).rejects.toMatchObject({
      code: "file_exists",
    });
    expect(readFileSync(target, "utf8")).toBe("original\n");

    await expect(adapter.download("/export-bad", target, { force: true })).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("original\n");
  });

  it("should stream over an existing target when force is set", async () => {
    const adapter = new HttpsAdapter({ baseUrl, caPem: tls.caPem });
    const directory = tempDirectory();
    const target = join(directory, "audit.ndjson");
    writeFileSync(target, "original\n", "utf8");
    await adapter.download("/export", target, { force: true });
    expect(readFileSync(target, "utf8")).toContain('"eventId":"one"');
  });
});
