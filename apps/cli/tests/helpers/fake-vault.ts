import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { createTestTls } from "./tls.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW = "2026-11-05T12:00:00.000Z";
const ACCESS_TOKEN = "access-token";
const REFRESH_TOKEN = "R".repeat(43);

/** One recorded request. */
export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** A fake vault for CLI tests. */
export interface FakeVault {
  url: URL;
  readonly caPath: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly requests: RecordedRequest[];
  readonly projects: Map<string, { id: string; name: string }>;
  readonly secrets: Map<
    string,
    {
      id: string;
      name: string;
      value: string;
      encoding: "utf8" | "base64";
      tags: Record<string, string>;
      rotationIntervalDays?: number | null;
    }
  >;
  readonly identities: Map<string, { id: string; name: string; projectId: string }>;
  readonly assignments: Array<{
    id: string;
    principalId: string;
    role: string;
    scopeType: string;
    scopeId: string;
  }>;
  readonly certificates: Map<
    string,
    { id: string; name: string; subject: string; fingerprint: string }
  >;
  auditOk: boolean;
  rejectNextAuthorized: boolean;
  failNextSecretWrite: boolean;
  auditExportFails: boolean;
  close(): Promise<void>;
}

/** Reads one request body. */
async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Sends one JSON response. */
function send(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

/** Sends one success envelope. */
function ok(response: ServerResponse, data: unknown, status = 200): void {
  send(response, status, { success: true, data });
}

/** Sends one error envelope. */
function fail(response: ServerResponse, status: number, code: string, message: string): void {
  send(response, status, { success: false, error: { code, message, statusCode: status } });
}

/** Builds a project shape. */
function project(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    certificateCount: 0,
  };
}

/** Builds secret metadata. */
function secretMetadata(
  secret: {
    id: string;
    name: string;
    value: string;
    encoding: "utf8" | "base64";
    tags: Record<string, string>;
    rotationIntervalDays?: number | null;
  },
  versionId = ULID,
): Record<string, unknown> {
  const interval = secret.rotationIntervalDays ?? null;
  const dueAt =
    interval === null ? null : new Date(Date.parse(NOW) + interval * 86_400_000).toISOString();
  const status =
    dueAt === null
      ? null
      : Date.parse(dueAt) <= Date.parse(NOW)
        ? "overdue"
        : Date.parse(dueAt) - Date.parse(NOW) <= 7 * 86_400_000
          ? "due_soon"
          : "ok";
  return {
    id: secret.id,
    projectId: ULID,
    name: secret.name,
    tags: secret.tags,
    contentType: "text/plain",
    status: "active",
    currentVersion: { id: versionId, createdAt: NOW, createdBy: ULID, expiresAt: null },
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    purgeAfter: null,
    purgeProtected: false,
    rotationIntervalDays: interval,
    rotationDueAt: dueAt,
    rotationStatus: status,
    consumers: [],
    capabilities: {
      canRead: true,
      canWrite: true,
      canDelete: true,
      canRecover: true,
      canPurge: true,
      canManage: true,
      canReadPrivate: true,
    },
  };
}

/**
 * Starts the fake vault.
 *
 * @returns The running fake.
 */
export async function startFakeVault(): Promise<FakeVault> {
  const tls = await createTestTls();
  const requests: RecordedRequest[] = [];
  const projects = new Map<string, { id: string; name: string }>();
  const secrets = new Map<
    string,
    {
      id: string;
      name: string;
      value: string;
      encoding: "utf8" | "base64";
      tags: Record<string, string>;
      rotationIntervalDays?: number | null;
    }
  >();
  const identities = new Map<string, { id: string; name: string; projectId: string }>();
  const assignments: Array<{
    id: string;
    principalId: string;
    role: string;
    scopeType: string;
    scopeId: string;
  }> = [];
  const certificates = new Map<
    string,
    { id: string; name: string; subject: string; fingerprint: string }
  >();
  const fake: FakeVault = {
    url: new URL("https://localhost"),
    caPath: tls.caPath,
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    requests,
    projects,
    secrets,
    identities,
    assignments,
    certificates,
    auditOk: true,
    rejectNextAuthorized: false,
    failNextSecretWrite: false,
    auditExportFails: false,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      tls.cleanup();
    },
  };

  const acceptedTokens = new Set<string>([ACCESS_TOKEN]);
  let server: ReturnType<typeof createServer> | undefined;
  server = createServer({ key: tls.keyPem, cert: tls.certPem }, async (request, response) => {
    const url = new URL(request.url ?? "/", "https://localhost");
    const body = await bodyOf(request);
    requests.push({
      method: request.method ?? "",
      path: url.pathname,
      query: url.search,
      authorization: request.headers.authorization,
      body,
    });
    const authorized = acceptedTokens.has(
      request.headers.authorization?.replace("Bearer ", "") ?? "",
    );
    const route = `${request.method ?? "GET"} ${url.pathname}`;
    if (route === "POST /v1/auth/cli/login") {
      const input = body as { identifier?: string; password?: string } | undefined;
      if (input?.password !== "correct-horse") {
        fail(response, 401, "invalid_credentials", "Invalid credentials");
        return;
      }
      ok(response, {
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        tokenType: "Bearer",
        accessExpiresAt: "2026-11-05T12:15:00.000Z",
        refreshExpiresAt: "2026-11-06T00:00:00.000Z",
        user: { id: ULID, name: "Ada", email: "ada@example.test", authMethod: "local" },
        mustChangePassword: false,
      });
      return;
    }
    if (route === "POST /v1/auth/cli/refresh") {
      acceptedTokens.add(`${ACCESS_TOKEN}-2`);
      ok(response, {
        accessToken: `${ACCESS_TOKEN}-2`,
        refreshToken: "S".repeat(43),
        tokenType: "Bearer",
        accessExpiresAt: "2026-11-05T12:30:00.000Z",
        refreshExpiresAt: "2026-11-06T00:00:00.000Z",
        user: { id: ULID, name: "Ada", email: "ada@example.test", authMethod: "local" },
        mustChangePassword: false,
      });
      return;
    }
    if (route === "POST /v1/auth/cli/logout") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (route === "GET /ready") {
      ok(response, { status: "ready" });
      return;
    }
    if (!authorized) {
      fail(response, 401, "authentication_required", "Authentication required");
      return;
    }
    if (fake.rejectNextAuthorized) {
      fake.rejectNextAuthorized = false;
      fail(response, 401, "authentication_required", "Authentication required");
      return;
    }
    if (route === "GET /v1/auth/cli/me") {
      ok(response, {
        user: { id: ULID, name: "Ada", email: "ada@example.test", authMethod: "local" },
        mustChangePassword: false,
      });
      return;
    }
    if (route === "GET /v1/auth/cli/sessions") {
      ok(response, {
        sessions: [
          { id: ULID, createdAt: NOW, expiresAt: "2026-11-06T00:00:00.000Z", current: true },
        ],
      });
      return;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/v1/auth/cli/sessions/")) {
      response.writeHead(204);
      response.end();
      return;
    }
    if (route === "GET /v1/admin/projects") {
      ok(response, {
        projects: [...projects.values()].map((entry) => project(entry.id, entry.name)),
      });
      return;
    }
    if (route === "POST /v1/admin/projects") {
      const input = body as { name: string };
      const id = randomBytes(13).toString("hex").slice(0, 26).toUpperCase();
      projects.set(input.name, { id, name: input.name });
      ok(response, project(id, input.name), 201);
      return;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/v1/admin/projects/")) {
      response.writeHead(204);
      response.end();
      return;
    }
    if (route === "GET /v1/data/payments/secrets") {
      const rotation = url.searchParams.get("rotation");
      const entries = [...secrets.values()].map((secret) => secretMetadata(secret));
      const filtered = entries.filter((entry) => {
        if (rotation === null) {
          return true;
        }
        const interval = entry.rotationIntervalDays as number | null;
        const status = entry.rotationStatus as string | null;
        if (rotation === "policy") {
          return interval !== null;
        }
        if (rotation === "due") {
          return status === "due_soon" || status === "overdue";
        }
        return status === "overdue";
      });
      ok(response, { secrets: filtered, nextCursor: null });
      return;
    }
    if (request.method === "GET" && url.pathname.match(/^\/v1\/data\/payments\/secrets\/[^/]+$/)) {
      const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const secret = secrets.get(name);
      if (secret === undefined) {
        fail(response, 404, "secret_not_found", "Secret not found");
        return;
      }
      ok(response, {
        id: secret.id,
        projectId: ULID,
        name: secret.name,
        value: secret.value,
        encoding: secret.encoding,
        contentType: "text/plain",
        tags: secret.tags,
        version: { id: ULID, createdAt: NOW, createdBy: ULID, expiresAt: null },
        capabilities: {
          canRead: true,
          canWrite: true,
          canDelete: true,
          canRecover: true,
          canPurge: true,
          canManage: true,
          canReadPrivate: true,
        },
      });
      return;
    }
    if (request.method === "PUT" && url.pathname.match(/^\/v1\/data\/payments\/secrets\/[^/]+$/)) {
      if (fake.failNextSecretWrite) {
        fake.failNextSecretWrite = false;
        fail(response, 503, "service_unavailable", "Service unavailable");
        return;
      }
      const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const input = body as { value: string; encoding?: "utf8" | "base64" };
      const existing = secrets.get(name);
      if (existing === undefined) {
        fail(response, 404, "secret_not_found", "Secret not found");
        return;
      }
      existing.value = input.value;
      existing.encoding = input.encoding ?? "utf8";
      ok(response, {
        ...secretMetadata(existing),
        version: { id: ULID, createdAt: NOW, createdBy: ULID, expiresAt: null },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/data/payments/secrets") {
      const input = body as {
        name: string;
        value: string;
        encoding?: "utf8" | "base64";
        tags?: Record<string, string>;
      };
      if (secrets.has(input.name)) {
        fail(response, 409, "secret_name_conflict", "Secret already exists");
        return;
      }
      const secret = {
        id: randomBytes(13).toString("hex").slice(0, 26).toUpperCase(),
        name: input.name,
        value: input.value,
        encoding: input.encoding ?? ("utf8" as const),
        tags: input.tags ?? {},
      };
      secrets.set(input.name, secret);
      ok(
        response,
        {
          ...secretMetadata(secret),
          version: { id: ULID, createdAt: NOW, createdBy: ULID, expiresAt: null },
        },
        201,
      );
      return;
    }
    if (
      request.method === "PATCH" &&
      url.pathname.match(/^\/v1\/data\/payments\/secrets\/[^/]+$/)
    ) {
      const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const existing = secrets.get(name);
      if (existing === undefined) {
        fail(response, 404, "secret_not_found", "Secret not found");
        return;
      }
      const input = body as {
        tags?: Record<string, string>;
        rotationIntervalDays?: number | null;
      };
      if (input.tags !== undefined) {
        existing.tags = input.tags;
      }
      if (input.rotationIntervalDays !== undefined) {
        existing.rotationIntervalDays = input.rotationIntervalDays;
      }
      ok(response, secretMetadata(existing));
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/versions")) {
      ok(response, {
        versions: [
          {
            id: ULID,
            createdAt: NOW,
            createdBy: ULID,
            expiresAt: null,
            status: "active",
            isCurrent: true,
          },
        ],
      });
      return;
    }
    if (
      request.method === "DELETE" &&
      url.pathname.match(/^\/v1\/data\/payments\/secrets\/[^/]+$/)
    ) {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/recover")) {
      ok(
        response,
        secretMetadata({ id: ULID, name: "db-password", value: "", encoding: "utf8", tags: {} }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/purge")) {
      response.writeHead(204);
      response.end();
      return;
    }
    if (route === "GET /v1/data/payments/certificates") {
      ok(response, {
        certificates: [...certificates.values()].map((entry) => ({
          id: entry.id,
          projectId: ULID,
          name: entry.name,
          tags: {},
          status: "active",
          subject: entry.subject,
          sans: ["DNS:api"],
          issuer: "CN=Test CA",
          serial: "01",
          fingerprint: entry.fingerprint,
          notBefore: NOW,
          notAfter: "2027-11-05T12:00:00.000Z",
          daysToExpiry: 365,
          chainLength: 1,
          version: {
            id: ULID,
            createdAt: NOW,
            createdBy: ULID,
            notBefore: NOW,
            notAfter: "2027-11-05T12:00:00.000Z",
            fingerprint: entry.fingerprint,
            serial: "01",
          },
          createdAt: NOW,
          updatedAt: NOW,
          deletedAt: null,
          purgeAfter: null,
          purgeProtected: false,
          capabilities: {
            canRead: true,
            canWrite: true,
            canDelete: true,
            canRecover: true,
            canPurge: true,
            canManage: true,
            canReadPrivate: true,
          },
        })),
        nextCursor: null,
      });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/certificates/generate")) {
      const input = body as { name: string; subject: string };
      const entry = {
        id: randomBytes(13).toString("hex").slice(0, 26).toUpperCase(),
        name: input.name,
        subject: input.subject,
        fingerprint: "a".repeat(64),
      };
      certificates.set(input.name, entry);
      ok(
        response,
        {
          id: entry.id,
          projectId: ULID,
          name: entry.name,
          tags: {},
          status: "active",
          subject: entry.subject,
          sans: ["DNS:api"],
          issuer: "CN=Test CA",
          serial: "01",
          fingerprint: entry.fingerprint,
          notBefore: NOW,
          notAfter: "2027-11-05T12:00:00.000Z",
          daysToExpiry: 365,
          chainLength: 1,
          version: {
            id: ULID,
            createdAt: NOW,
            createdBy: ULID,
            notBefore: NOW,
            notAfter: "2027-11-05T12:00:00.000Z",
            fingerprint: entry.fingerprint,
            serial: "01",
          },
          createdAt: NOW,
          updatedAt: NOW,
          deletedAt: null,
          purgeAfter: null,
          purgeProtected: false,
          capabilities: {
            canRead: true,
            canWrite: true,
            canDelete: true,
            canRecover: true,
            canPurge: true,
            canManage: true,
            canReadPrivate: true,
          },
          certificatePem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
          chainPem: "",
          warnings: [],
        },
        201,
      );
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname.match(/^\/v1\/data\/payments\/certificates\/[^/]+$/)
    ) {
      const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const entry = certificates.get(name);
      if (entry === undefined) {
        fail(response, 404, "certificate_not_found", "Certificate not found");
        return;
      }
      ok(response, {
        id: entry.id,
        projectId: ULID,
        name: entry.name,
        tags: {},
        status: "active",
        subject: entry.subject,
        sans: ["DNS:api"],
        issuer: "CN=Test CA",
        serial: "01",
        fingerprint: entry.fingerprint,
        notBefore: NOW,
        notAfter: "2027-11-05T12:00:00.000Z",
        daysToExpiry: 365,
        chainLength: 1,
        version: {
          id: ULID,
          createdAt: NOW,
          createdBy: ULID,
          notBefore: NOW,
          notAfter: "2027-11-05T12:00:00.000Z",
          fingerprint: entry.fingerprint,
          serial: "01",
        },
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        purgeAfter: null,
        purgeProtected: false,
        capabilities: {
          canRead: true,
          canWrite: true,
          canDelete: true,
          canRecover: true,
          canPurge: true,
          canManage: true,
          canReadPrivate: true,
        },
        certificatePem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
        chainPem: "",
      });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/private-key")) {
      ok(response, {
        id: ULID,
        projectId: ULID,
        name: "api",
        fingerprint: "a".repeat(64),
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
        version: {
          id: ULID,
          createdAt: NOW,
          createdBy: ULID,
          notBefore: NOW,
          notAfter: "2027-11-05T12:00:00.000Z",
          fingerprint: "a".repeat(64),
          serial: "01",
        },
        capabilities: {
          canRead: true,
          canWrite: true,
          canDelete: true,
          canRecover: true,
          canPurge: true,
          canManage: true,
          canReadPrivate: true,
        },
      });
      return;
    }
    if (
      request.method === "DELETE" &&
      url.pathname.match(/^\/v1\/data\/payments\/certificates\/[^/]+$/)
    ) {
      response.writeHead(204);
      response.end();
      return;
    }
    if (route === "GET /v1/admin/identities") {
      ok(response, {
        identities: [...identities.values()].map((entry) => ({
          ...entry,
          status: "active",
          createdAt: NOW,
        })),
      });
      return;
    }
    if (route === "POST /v1/admin/identities") {
      const input = body as { name: string; projectId: string };
      const entry = {
        id: randomBytes(13).toString("hex").slice(0, 26).toUpperCase(),
        name: input.name,
        projectId: input.projectId,
      };
      identities.set(entry.id, entry);
      ok(response, { ...entry, status: "active", createdAt: NOW }, 201);
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/revoke")) {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/join-tokens")) {
      ok(response, { id: ULID, token: "J".repeat(43), expiresAt: "2026-11-05T12:15:00.000Z" }, 201);
      return;
    }
    if (route === "GET /v1/admin/assignments") {
      ok(response, {
        assignments: assignments.map((entry) => ({
          ...entry,
          grantedBy: ULID,
          createdAt: NOW,
          expiresAt: null,
        })),
      });
      return;
    }
    if (route === "POST /v1/admin/assignments") {
      const input = body as {
        principalId: string;
        role: string;
        scopeType: string;
        scopeId: string;
      };
      const entry = { id: randomBytes(13).toString("hex").slice(0, 26).toUpperCase(), ...input };
      assignments.push(entry);
      ok(response, { ...entry, grantedBy: ULID, createdAt: NOW, expiresAt: null }, 201);
      return;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/v1/admin/assignments/")) {
      response.writeHead(204);
      response.end();
      return;
    }
    if (route === "GET /v1/admin/access-explain") {
      ok(response, {
        policyVersion: 1,
        action: url.searchParams.get("action") ?? "secret.read",
        scope: {
          type: url.searchParams.get("scopeType") ?? "object",
          id: url.searchParams.get("scopeId") ?? ULID,
        },
        principals: [
          {
            principalId: ULID,
            name: "api",
            kind: "service",
            role: "secrets.reader",
            assignmentId: ULID,
            scopeType: "object",
            scopeId: ULID,
            consumer: {
              composeProject: "payments",
              composeService: "api",
              hostname: "api-1",
              state: "ok",
              lastSeen: NOW,
            },
          },
        ],
      });
      return;
    }
    if (route === "GET /v1/audit/events") {
      ok(response, {
        events: [
          {
            eventId: ULID,
            ts: NOW,
            projectId: ULID,
            requestId: "req-1",
            actorId: ULID,
            actorKind: "user",
            action: "secret.read",
            scopeType: "object",
            scopeId: ULID,
            objectType: "secret",
            objectId: ULID,
            result: "allow",
            sourceIp: null,
            userAgent: null,
            details: {},
            prevHash: "a".repeat(64),
            hash: "b".repeat(64),
            hmac: "c".repeat(64),
            auditKeyId: ULID,
          },
        ],
        nextCursor: null,
      });
      return;
    }
    if (route === "GET /v1/audit/verify") {
      ok(response, {
        ok: fake.auditOk,
        checkedRange: { fromEventId: ULID, toEventId: ULID },
        firstBrokenEventId: fake.auditOk ? null : ULID,
        reason: fake.auditOk ? "ok" : "hash_mismatch",
      });
      return;
    }
    if (route === "GET /v1/audit/export") {
      if (fake.auditExportFails) {
        fail(response, 403, "access_denied", "Export denied");
        return;
      }
      const bodyText = `${JSON.stringify({ eventId: ULID })}\n`;
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Content-Length": Buffer.byteLength(bodyText),
      });
      response.end(bodyText);
      return;
    }
    if (route === "POST /v1/admin/scaffold") {
      const input = body as { project: string; service: string; entries: string[] };
      const identityId = identities.values().next().value?.id ?? ULID;
      ok(response, {
        project: { id: ULID, name: input.project, createdAt: NOW, updatedAt: NOW, deletedAt: null },
        identity: {
          id: identityId,
          name: input.service,
          projectId: ULID,
          status: "active",
          createdAt: NOW,
        },
        assignments: input.entries.map((name) => ({
          name,
          assignment: {
            id: ULID,
            principalId: identityId,
            role: "secrets.reader",
            scopeType: "object",
            scopeId: ULID,
            grantedBy: ULID,
            createdAt: NOW,
            expiresAt: null,
          },
        })),
        joinToken: { id: ULID, token: "J".repeat(43), expiresAt: "2026-11-05T12:15:00.000Z" },
        compose: `services:\n  openvault-agent-${input.service}:\n    environment:\n      OPENVAULT_JOIN_TOKEN: "\${OPENVAULT_JOIN_TOKEN}"\n`,
        manifest: `project: "${input.project}"\nservice: "${input.service}"\n`,
        manifestFile: `openvault.\${COMPOSE_PROJECT_NAME}.${input.service}.manifest.yaml`,
      });
      return;
    }
    fail(response, 404, "not_found", "Not found");
  });

  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const address = server?.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake vault did not bind");
  }
  fake.url = new URL(`https://localhost:${address.port}`);
  return fake;
}
