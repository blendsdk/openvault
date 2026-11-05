import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApplication } from "../../src/app.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import type {
  SecureWebApplication,
  TransportHandle,
} from "../../src/transport/secure-application.js";
import { TlsMaterial } from "../../src/transport/tls.js";
import { type TestResponse, testRequest } from "./helpers/https.js";
import { createServerEnvironment, type ServerEnvironment } from "./helpers/server-environment.js";

const trustedHost = (() => {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (
        String(entry.family) === "IPv4" &&
        !entry.internal &&
        !entry.address.startsWith("169.254.")
      ) {
        return entry.address;
      }
    }
  }
  return undefined;
})();

function trustedProxyCidrs(): string {
  return trustedHost === undefined
    ? "127.0.0.1/32,::1/128"
    : `127.0.0.1/32,::1/128,${trustedHost}/32`;
}

interface Running {
  readonly app: SecureWebApplication;
  readonly handle: TransportHandle;
  readonly environment: ServerEnvironment;
}

let webRoot: string;
let emptyRoot: string;
let previousWebRoot: string | undefined;
let running: Running;

async function startApp(environment: ServerEnvironment): Promise<Running> {
  const keyring = await KeyringProvider.load(environment.keyringPath);
  const tls = TlsMaterial.load(environment.config);
  const database = new PostgreSQLDatabase({
    ...environment.config.database,
    poolConfig: { connectionTimeoutMillis: 2_000 },
    enableGracefulShutdown: false,
  });
  const app = await createTestApplication(environment.config, { database, tls, keyring });
  const handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
  return { app, handle, environment };
}

function send(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<TestResponse> {
  return testRequest({
    host: trustedHost ?? "127.0.0.1",
    port,
    path,
    headers,
    ca: running.environment.tls.caPem,
    servername: "localhost",
  });
}

beforeAll(async () => {
  previousWebRoot = process.env.OPENVAULT_WEB_ROOT;
  webRoot = mkdtempSync(join(tmpdir(), "openvault-web-"));
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(
    join(webRoot, "index.html"),
    '<!doctype html><html lang="en"><body><div id="root">OpenVault UI</div></body></html>',
    "utf8",
  );
  writeFileSync(join(webRoot, "assets", "app-abc.js"), "console.log('ui');\n", "utf8");
  emptyRoot = mkdtempSync(join(tmpdir(), "openvault-empty-"));
  process.env.OPENVAULT_WEB_ROOT = webRoot;
  const environment = createServerEnvironment({
    OPENVAULT_PROXY_CIDRS: trustedProxyCidrs(),
  });
  running = await startApp(environment);
}, 60_000);

afterAll(async () => {
  if (running !== undefined) {
    await running.handle.stop();
    running.environment.cleanup();
  }
  if (previousWebRoot === undefined) {
    delete process.env.OPENVAULT_WEB_ROOT;
  } else {
    process.env.OPENVAULT_WEB_ROOT = previousWebRoot;
  }
  rmSync(webRoot, { recursive: true, force: true });
  rmSync(emptyRoot, { recursive: true, force: true });
});

describe.skipIf(trustedHost === undefined)("web UI serving", () => {
  it("should serve the SPA root, hashed assets, and client routes", async () => {
    const root = await send(running.handle.adminPort, "/", { accept: "text/html" });
    expect(root.status).toBe(200);
    expect(root.body).toContain("OpenVault UI");
    expect(root.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(root.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(root.headers["content-security-policy"]).not.toContain("unsafe-eval");

    const nested = await send(running.handle.adminPort, "/projects/payments", {
      accept: "text/html",
    });
    expect(nested.status).toBe(200);
    expect(nested.body).toContain("OpenVault UI");

    const asset = await send(running.handle.adminPort, "/assets/app-abc.js");
    expect(asset.status).toBe(200);
    expect(asset.body).toContain("console.log");
    expect(String(asset.headers["cache-control"])).toContain("immutable");
  });

  it("should keep unknown API routes as JSON 404s for every Accept header", async () => {
    for (const accept of ["application/json", "text/html"]) {
      const response = await send(running.handle.adminPort, "/v1/does-not-exist", { accept });
      expect(response.status).toBe(404);
      expect(response.json).toMatchObject({ success: false });
      expect(String(response.headers["content-type"])).toContain("application/json");
    }
  });

  it("should keep the deny-by-default CSP when the UI is absent", async () => {
    process.env.OPENVAULT_WEB_ROOT = emptyRoot;
    const environment = createServerEnvironment({
      OPENVAULT_PROXY_CIDRS: trustedProxyCidrs(),
    });
    const withoutUi = await startApp(environment);
    try {
      const response = await testRequest({
        host: trustedHost ?? "127.0.0.1",
        port: withoutUi.handle.adminPort,
        path: "/health",
        ca: environment.tls.caPem,
        servername: "localhost",
      });
      expect(response.status).toBe(200);
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    } finally {
      await withoutUi.handle.stop();
      environment.cleanup();
    }
  }, 30_000);
});
