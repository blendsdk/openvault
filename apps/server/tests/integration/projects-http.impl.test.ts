import { networkInterfaces } from "node:os";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApplication } from "../../src/app.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/cookie.js";
import type { SessionService } from "../../src/auth/sessions.js";
import { KeyringProvider } from "../../src/security/keyring.js";
import type {
  SecureWebApplication,
  TransportHandle,
} from "../../src/transport/secure-application.js";
import { TlsMaterial } from "../../src/transport/tls.js";
import { type AuditActors, seedAuditActors } from "./helpers/audit-harness.js";
import { type BaseFixture, seedBase } from "./helpers/fixtures.js";
import { type TestResponse, testRequest } from "./helpers/https.js";
import { createServerEnvironment } from "./helpers/server-environment.js";
import { applyMigrations, createTestDatabase, type TestDatabase } from "./helpers/test-database.js";

function externalIpv4(): string | undefined {
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
}

const trustedHost = externalIpv4();

let testDb: TestDatabase;
let base: BaseFixture;
let actors: AuditActors;
let environment: ReturnType<typeof createServerEnvironment>;
let app: SecureWebApplication;
let handle: TransportHandle;
let cookie: string;
let csrf: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);
  environment = createServerEnvironment({
    OPENVAULT_DB_URL: testDb.url,
    OPENVAULT_PROXY_CIDRS:
      trustedHost === undefined ? "127.0.0.1/32,::1/128" : `127.0.0.1/32,::1/128,${trustedHost}/32`,
  });
  const keyring = await KeyringProvider.load(environment.keyringPath);
  const tls = TlsMaterial.load(environment.config);
  const database = new PostgreSQLDatabase({
    ...environment.config.database,
    poolConfig: { connectionTimeoutMillis: 2_000 },
    enableGracefulShutdown: false,
  });
  app = await createTestApplication(environment.config, { database, tls, keyring });
  handle = await app.startTransport({ adminPort: 0, agentPort: 0 });
  const sessions = await app.getService<SessionService>("sessions");
  const session = await sessions.create({ principalId: actors.orgAdmin, authMethod: "local" });
  cookie = `${SESSION_COOKIE_NAME}=${session.secretId}`;
  csrf = session.record.csrfToken;
}, 60_000);

afterAll(async () => {
  await handle?.stop();
  environment?.cleanup();
  await testDb?.cleanup();
});

async function send(path: string, method = "GET", body?: string): Promise<TestResponse> {
  return testRequest({
    port: handle.adminPort,
    path,
    method,
    host: trustedHost ?? "127.0.0.1",
    ca: environment.tls.caPem,
    servername: "localhost",
    headers: {
      cookie,
      origin: environment.config.baseUrl.origin,
      ...(method === "GET" ? {} : { "x-csrf-token": csrf }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
  });
}

describe("project HTTP routes", () => {
  it("should create, list, read, rename, and delete a project", async () => {
    const created = await send(
      "/v1/admin/projects",
      "POST",
      JSON.stringify({ name: "http-project" }),
    );
    expect(created.status, created.body).toBe(201);
    const project = (created.json as { data: { id: string; createdAt: string } }).data;
    expect(project.createdAt).toBeTypeOf("string");
    expect(project.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const list = await send("/v1/admin/projects");
    expect(list.status, list.body).toBe(200);
    const projects = (list.json as { data: { projects: { id: string }[] } }).data.projects;
    expect(projects.some((entry) => entry.id === project.id)).toBe(true);

    const read = await send(`/v1/admin/projects/${project.id}`);
    expect(read.status, read.body).toBe(200);

    const renamed = await send(
      `/v1/admin/projects/${project.id}`,
      "PATCH",
      JSON.stringify({ name: "http-project-renamed" }),
    );
    expect(renamed.status, renamed.body).toBe(200);
    expect((renamed.json as { data: { name: string } }).data.name).toBe("http-project-renamed");

    const deleted = await send(`/v1/admin/projects/${project.id}`, "DELETE");
    expect(deleted.status).toBe(204);
    expect((await send(`/v1/admin/projects/${project.id}`)).status).toBe(404);
  });

  it("should reject a duplicate project name with 409", async () => {
    const name = "http-duplicate";
    expect((await send("/v1/admin/projects", "POST", JSON.stringify({ name }))).status).toBe(201);
    const duplicate = await send("/v1/admin/projects", "POST", JSON.stringify({ name }));
    expect(duplicate.status).toBe(409);
    expect((duplicate.json as { error: { code: string } }).error.code).toBe(
      "project_name_conflict",
    );
  });
});
