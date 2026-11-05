import type { AdapterRequest, AdapterResponse, RequestAdapter } from "blendsdk/api-client";

const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SECRET_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const VERSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const IDENTITY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const ASSIGNMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const OBJECT_ASSIGNMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB8";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const ADMIN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const CSRF = "c".repeat(32);

interface Envelope {
  readonly success: true;
  readonly data: unknown;
}

function ok(data: unknown, status = 200): AdapterResponse {
  return { status, ok: status >= 200 && status < 300, body: { success: true, data } as Envelope };
}

function noContent(): AdapterResponse {
  return { status: 204, ok: true, body: undefined };
}

function failure(status: number, code: string, message: string): AdapterResponse {
  return {
    status,
    ok: false,
    body: { success: false, error: { code, message, requestId: "req-test" } },
  };
}

/** A recorded request. */
export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/**
 * In-memory API adapter used by component tests.
 *
 * It exercises the real generated client, URL building, envelopes, and the
 * CSRF header rather than mocking page code.
 */
export class FakeVault implements RequestAdapter {
  readonly requests: RecordedRequest[] = [];
  readonly projects = [
    {
      id: PROJECT_ID,
      name: "payments",
      createdAt: "2026-11-01T10:00:00.000Z",
      updatedAt: "2026-11-02T11:00:00.000Z",
      deletedAt: null,
      certificateCount: 0,
    },
    {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
      name: "billing",
      createdAt: "2026-11-03T10:00:00.000Z",
      updatedAt: "2026-11-03T10:00:00.000Z",
      deletedAt: null,
      certificateCount: 1,
    },
  ];
  secrets = [
    {
      id: SECRET_ID,
      projectId: PROJECT_ID,
      name: "db-password",
      tags: { env: "prod" },
      contentType: "text/plain",
      status: "active",
      currentVersion: {
        id: VERSION_ID,
        createdAt: "2026-11-02T10:00:00.000Z",
        createdBy: ADMIN_ID,
        expiresAt: null,
      },
      createdAt: "2026-11-02T10:00:00.000Z",
      updatedAt: "2026-11-02T10:00:00.000Z",
      deletedAt: null,
      purgeAfter: null,
      purgeProtected: false,
      consumers: [],
      capabilities: {
        canRead: true,
        canWrite: true,
        canDelete: true,
        canPurge: true,
        canManage: true,
      },
    },
  ];
  identities = [
    {
      id: IDENTITY_ID,
      name: "payments-api",
      projectId: PROJECT_ID,
      status: "active",
      createdAt: "2026-11-02T10:00:00.000Z",
    },
  ];
  assignments = [
    {
      id: ASSIGNMENT_ID,
      principalId: IDENTITY_ID,
      role: "secrets.reader",
      scopeType: "project",
      scopeId: PROJECT_ID,
      grantedBy: ADMIN_ID,
      createdAt: "2026-11-02T10:00:00.000Z",
      expiresAt: null,
    },
    {
      id: OBJECT_ASSIGNMENT_ID,
      principalId: IDENTITY_ID,
      role: "secrets.reader",
      scopeType: "object",
      scopeId: SECRET_ID,
      grantedBy: ADMIN_ID,
      createdAt: "2026-11-02T10:05:00.000Z",
      expiresAt: null,
    },
  ];
  secretValue = "s3cret-value";
  revealCount = 0;
  denyReveal = false;
  emptySecrets = false;
  mustChangePassword = false;
  oidcEnabled = false;
  auditBroken = false;

  readonly session = {
    user: {
      id: ADMIN_ID,
      sub: ADMIN_ID,
      name: "Ada Admin",
      email: "ada@example.test",
      authMethod: "local" as const,
    },
    expiresAt: "2026-11-07T10:00:00.000Z",
    csrfToken: CSRF,
    mustChangePassword: false,
    lastLoginAt: "2026-11-06T10:00:00.000Z",
  };

  public async send(request: AdapterRequest): Promise<AdapterResponse> {
    const url = new URL(request.url, "https://vault.test");
    const body = request.body === undefined ? undefined : (JSON.parse(request.body) as unknown);
    this.requests.push({
      method: request.method,
      path: url.pathname,
      query: url.search,
      headers: request.headers,
      body,
    });
    const method = request.method.toUpperCase();
    const path = url.pathname;

    if (method === "POST" && path === "/v1/auth/local/login") {
      return ok({ ...this.session, mustChangePassword: this.mustChangePassword });
    }
    if (method === "GET" && path === "/v1/auth/me") {
      return ok({ ...this.session, mustChangePassword: this.mustChangePassword });
    }
    if (method === "POST" && path === "/v1/auth/password") {
      return ok({ csrfToken: "d".repeat(32), expiresAt: this.session.expiresAt });
    }
    if (method === "POST" && path === "/v1/auth/refresh") {
      return ok({ csrfToken: "d".repeat(32), expiresAt: this.session.expiresAt });
    }
    if (method === "POST" && path === "/v1/auth/logout") {
      return noContent();
    }
    if (method === "GET" && path === "/v1/meta/auth") {
      return ok({ local: true, oidc: this.oidcEnabled });
    }
    if (method === "GET" && path === "/v1/meta/roles") {
      return ok({
        policyVersion: 1,
        actions: [
          { name: "secret.read", plane: "data", description: "Read a secret value" },
          { name: "project.read", plane: "control", description: "Read a project" },
        ],
        roles: [
          { name: "secrets.reader", actions: ["secret.read"], scopes: ["project", "object"] },
          { name: "project.admin", actions: ["project.read"], scopes: ["project"] },
          { name: "org.admin", actions: ["project.read"], scopes: ["org", "project"] },
        ],
      });
    }
    if (path === "/v1/admin/projects" && method === "GET") {
      return ok({ projects: this.projects });
    }
    const projectMatch = /^\/v1\/admin\/projects\/([^/]+)$/.exec(path);
    if (projectMatch !== null) {
      const id = decodeURIComponent(projectMatch[1] ?? "");
      const index = this.projects.findIndex((project) => project.id === id);
      if (index === -1) {
        return failure(404, "project_not_found", "Project not found");
      }
      if (method === "PATCH") {
        const name = (body as { name?: string } | undefined)?.name;
        if (typeof name !== "string") {
          return failure(422, "validation_error", "Validation failed");
        }
        const updated = { ...this.projects[index], name, updatedAt: "2026-11-06T10:00:00.000Z" };
        this.projects[index] = updated;
        return ok(updated);
      }
      if (method === "DELETE") {
        this.projects.splice(index, 1);
        return noContent();
      }
    }
    if (path === "/v1/admin/projects" && method === "POST") {
      return ok(
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FB3",
          name: (body as { name?: string } | undefined)?.name ?? "new",
          createdAt: "2026-11-06T10:00:00.000Z",
          updatedAt: "2026-11-06T10:00:00.000Z",
          deletedAt: null,
        },
        201,
      );
    }

    const secretMatch =
      /^\/v1\/data\/([^/]+)\/secrets(?:\/([^/]+)(\/versions|\/consumers)?)?$/.exec(path);
    if (secretMatch !== null) {
      const projectName = decodeURIComponent(secretMatch[1] ?? "");
      const secretName =
        secretMatch[2] === undefined ? undefined : decodeURIComponent(secretMatch[2]);
      const suffix = secretMatch[3];
      if (projectName !== "payments") {
        return failure(404, "project_not_found", "Project not found");
      }
      if (method === "GET" && secretName === undefined) {
        if (this.emptySecrets) {
          return ok({ secrets: [], nextCursor: null });
        }
        return ok({ secrets: this.secrets, nextCursor: null });
      }
      if (method === "GET" && secretName !== undefined && suffix === "/versions") {
        return ok({
          versions: [
            {
              id: VERSION_ID,
              createdAt: "2026-11-02T10:00:00.000Z",
              createdBy: ADMIN_ID,
              expiresAt: null,
              isCurrent: true,
              status: "active",
            },
          ],
        });
      }
      if (method === "GET" && secretName !== undefined && suffix === "/consumers") {
        return ok({ consumers: [] });
      }
      if (method === "GET" && secretName !== undefined) {
        this.revealCount += 1;
        if (this.denyReveal) {
          return failure(403, "access_denied", "Access denied");
        }
        return ok({
          id: SECRET_ID,
          projectId: PROJECT_ID,
          name: secretName,
          value: this.secretValue,
          encoding: "utf8",
          contentType: "text/plain",
          tags: { env: "prod" },
          version: this.secrets[0]?.currentVersion,
          capabilities: this.secrets[0]?.capabilities,
        });
      }
    }

    const identityMatch = /^\/v1\/admin\/identities(?:\/([^/]+)(\/revoke|\/join-tokens)?)?$/.exec(
      path,
    );
    if (identityMatch !== null) {
      const id = identityMatch[1];
      const suffix = identityMatch[2];
      if (method === "GET" && id === undefined) {
        return ok({ identities: this.identities });
      }
      if (method === "POST" && id === undefined) {
        return ok(
          {
            id: "01ARZ3NDEKTSV4RRFFQ69G5FB4",
            name: (body as { name?: string } | undefined)?.name ?? "new-identity",
            projectId: PROJECT_ID,
            status: "active",
            createdAt: "2026-11-06T10:00:00.000Z",
          },
          201,
        );
      }
      if (method === "GET" && id !== undefined) {
        return ok({
          ...this.identities[0],
          certificates: [],
          consumer: {
            composeProject: "payments",
            composeService: "api",
            hostname: "internal-host",
            manifestHash: `sha256:${"a".repeat(64)}`,
            state: "ok",
            firstSeen: "2026-11-02T10:00:00.000Z",
            lastSeen: "2026-11-06T09:00:00.000Z",
            selfReported: true,
          },
        });
      }
      if (method === "POST" && suffix === "/revoke") {
        return noContent();
      }
      if (method === "POST" && suffix === "/join-tokens") {
        return ok(
          {
            id: "01ARZ3NDEKTSV4RRFFQ69G5FB5",
            token: "T".repeat(43),
            expiresAt: "2026-11-06T11:00:00.000Z",
          },
          201,
        );
      }
    }

    if (path === "/v1/admin/assignments" && method === "GET") {
      return ok({ assignments: this.assignments });
    }
    if (path === "/v1/admin/assignments" && method === "POST") {
      return ok(
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FB6",
          principalId: (body as { principalId?: string } | undefined)?.principalId ?? IDENTITY_ID,
          role: "secrets.reader",
          scopeType: "project",
          scopeId: PROJECT_ID,
          grantedBy: ADMIN_ID,
          createdAt: "2026-11-06T10:00:00.000Z",
          expiresAt: null,
        },
        201,
      );
    }
    if (path.startsWith("/v1/admin/assignments/") && method === "DELETE") {
      return noContent();
    }
    if (path === "/v1/admin/access-explain" && method === "GET") {
      return ok({
        policyVersion: 1,
        action: "project.read",
        scope: { type: "project", id: PROJECT_ID },
        principals: [
          {
            principalId: IDENTITY_ID,
            name: "payments-api",
            kind: "service",
            role: "secrets.reader",
            assignmentId: ASSIGNMENT_ID,
            scopeType: "project",
            scopeId: PROJECT_ID,
            consumer: null,
          },
        ],
      });
    }
    if (path === "/v1/audit/events" && method === "GET") {
      return ok({
        events: [
          {
            eventId: EVENT_ID,
            ts: "2026-11-06T09:30:00.000Z",
            projectId: PROJECT_ID,
            requestId: "req-1",
            actorId: ADMIN_ID,
            actorKind: "user",
            action: "secret.read",
            scopeType: "object",
            scopeId: SECRET_ID,
            objectType: "secret",
            objectId: SECRET_ID,
            result: "allow",
            sourceIp: "172.18.0.2",
            userAgent: "test",
            details: { version: VERSION_ID },
            prevHash: "0".repeat(64),
            hash: "1".repeat(64),
            hmac: "2".repeat(64),
            auditKeyId: "01ARZ3NDEKTSV4RRFFQ69G5FB7",
          },
        ],
        nextCursor: null,
      });
    }
    if (path === "/v1/audit/verify" && method === "GET") {
      return ok({
        ok: !this.auditBroken,
        checkedRange: this.auditBroken ? null : { fromEventId: EVENT_ID, toEventId: EVENT_ID },
        firstBrokenEventId: this.auditBroken ? EVENT_ID : null,
        reason: this.auditBroken ? "hash_mismatch" : "ok",
      });
    }

    return failure(404, "not_found", `Unhandled test route ${method} ${path}`);
  }
}

/** The fixed CSRF token used by test clients. */
export const TEST_CSRF = CSRF;

/** The project id used by test fixtures. */
export const TEST_PROJECT_ID = PROJECT_ID;
