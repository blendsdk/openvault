import type { AdapterRequest, AdapterResponse, RequestAdapter } from "blendsdk/api-client";
import type { OpenVaultWebClient } from "../../src/generated/index.js";

const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const VALUE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const VERSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const IDENTITY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const ASSIGNMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const OBJECT_ASSIGNMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB8";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const ADMIN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const CERTIFICATE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
export const CERTIFICATE_VERSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC2";
const CERTIFICATE_DELETED_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC3";
const CERTIFICATE_LOCKED_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC4";
const CERTIFICATE_EXPIRED_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC5";
const CSRF = "c".repeat(32);

/** Public certificate PEM used by display and download tests. */
export const TEST_CERTIFICATE_PEM =
  "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
/** Intermediate chain PEM used by display and download tests. */
export const TEST_CHAIN_PEM = "-----BEGIN CERTIFICATE-----\nMIIBCHAIN\n-----END CERTIFICATE-----\n";
/** Private key PEM used by reveal and download tests. */
export const TEST_PRIVATE_KEY_PEM =
  "-----BEGIN PRIVATE KEY-----\nMIIBKEY\n-----END PRIVATE KEY-----\n";

type CertificateRecord = Awaited<
  ReturnType<OpenVaultWebClient["certificates"]["listCertificates"]>
>["certificates"][number];

/** One certificate fixture with the full browser metadata shape. */
export function certificate(
  overrides: Partial<CertificateRecord> & Pick<CertificateRecord, "id" | "name" | "status">,
): CertificateRecord {
  return {
    projectId: PROJECT_ID,
    tags: {},
    subject: `CN=${overrides.name}.payments.internal`,
    sans: [`DNS:${overrides.name}.payments.internal`],
    issuer: `CN=${overrides.name}.payments.internal`,
    serial: "01",
    fingerprint: "a".repeat(64),
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-03-12T00:00:00.000Z",
    daysToExpiry: 124,
    chainLength: 1,
    version: {
      id: CERTIFICATE_VERSION_ID,
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: ADMIN_ID,
      notBefore: "2026-01-01T00:00:00.000Z",
      notAfter: "2027-03-12T00:00:00.000Z",
      fingerprint: "a".repeat(64),
      serial: "01",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    deletedAt: null,
    purgeAfter: null,
    purgeProtected: false,
    capabilities: {
      canRead: true,
      canWrite: true,
      canDelete: true,
      canRecover: true,
      canPurge: true,
      canManage: false,
      canReadPrivate: true,
    },
    ...overrides,
  };
}

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
      id: VALUE_ID,
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
      rotationIntervalDays: null,
      rotationDueAt: null,
      rotationStatus: null,
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
    },
  ];
  certificates: CertificateRecord[] = [
    certificate({
      id: CERTIFICATE_ID,
      name: "api-tls",
      status: "active",
      subject: "CN=api.payments.internal",
      sans: ["DNS:api.payments.internal"],
      tags: { env: "prod" },
    }),
    certificate({
      id: CERTIFICATE_EXPIRED_ID,
      name: "old-tls",
      status: "expired",
      subject: "CN=old.payments.internal",
      sans: ["DNS:old.payments.internal"],
      notAfter: "2026-01-01T00:00:00.000Z",
      daysToExpiry: -311,
    }),
    certificate({
      id: CERTIFICATE_DELETED_ID,
      name: "retired-tls",
      status: "deleted",
      subject: "CN=retired.payments.internal",
      sans: ["DNS:retired.payments.internal"],
      deletedAt: "2026-10-01T00:00:00.000Z",
      purgeAfter: "2026-10-31T00:00:00.000Z",
    }),
    certificate({
      id: CERTIFICATE_LOCKED_ID,
      name: "locked-tls",
      status: "deleted",
      subject: "CN=locked.payments.internal",
      sans: ["DNS:locked.payments.internal"],
      deletedAt: "2026-11-01T00:00:00.000Z",
      purgeAfter: "2026-12-01T00:00:00.000Z",
      purgeProtected: true,
    }),
  ];
  certificateWarnings: { code: string; message: string }[] = [];
  certificateLeafPem = TEST_CERTIFICATE_PEM;
  certificateChainPem = TEST_CHAIN_PEM;
  failCertificate: { status: number; code: string; message: string } | undefined;
  denyPrivateKey = false;
  privateKeyRevealCount = 0;
  certificateReadGate: Promise<void> | undefined;
  certificateVersionId = CERTIFICATE_VERSION_ID;
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
      scopeId: VALUE_ID,
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

  #certificateSequence = 0;
  #versionSequence = 0;

  /** Creates or renews one certificate and returns its write response. */
  #writeCertificate(
    name: string,
    expectedVersionId: string | undefined,
    subject: string,
    sans: readonly string[],
    tags: Record<string, string>,
    certificatePem: string,
    chainPem: string,
  ): AdapterResponse {
    if (expectedVersionId !== undefined && expectedVersionId !== this.certificateVersionId) {
      return failure(
        409,
        "certificate_version_conflict",
        "This certificate changed. Reload the page and try again.",
      );
    }
    this.#versionSequence += 1;
    const versionId = `01ARZ3NDEKTSV4RRFFQ69G5FD${this.#versionSequence}`;
    const existing = this.certificates.find((entry) => entry.name === name);
    if (existing !== undefined) {
      existing.subject = subject;
      existing.sans = [...sans];
      existing.tags = tags;
      existing.status = "active";
      existing.deletedAt = null;
      existing.purgeAfter = null;
      existing.updatedAt = "2026-11-08T12:00:00.000Z";
      existing.version = { ...existing.version, id: versionId };
      this.certificateVersionId = versionId;
      return ok({ ...existing, certificatePem, chainPem, warnings: this.certificateWarnings });
    }
    this.#certificateSequence += 1;
    const created = certificate({
      id: `01ARZ3NDEKTSV4RRFFQ69G5FE${this.#certificateSequence}`,
      name,
      status: "active",
      subject,
      sans: [...sans],
      tags,
    });
    created.version = { ...created.version, id: versionId };
    this.certificates.push(created);
    this.certificateVersionId = versionId;
    return ok({ ...created, certificatePem, chainPem, warnings: this.certificateWarnings }, 201);
  }

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
          id: VALUE_ID,
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

    const certificateBase = /^\/v1\/data\/([^/]+)\/certificates(\/.*)?$/.exec(path);
    if (certificateBase !== null) {
      const projectName = decodeURIComponent(certificateBase[1] ?? "");
      if (projectName !== "payments") {
        return failure(404, "project_not_found", "Project not found");
      }
      if (this.failCertificate !== undefined) {
        const fault = this.failCertificate;
        this.failCertificate = undefined;
        return failure(fault.status, fault.code, fault.message);
      }
      const rest = certificateBase[2] ?? "";
      const certificateBody = body as
        | {
            readonly name?: string;
            readonly certificatePem?: string;
            readonly chainPem?: string;
            readonly privateKeyPem?: string;
            readonly subject?: string;
            readonly sans?: readonly string[];
            readonly keyType?: string;
            readonly validityDays?: number;
            readonly allowNotYetValid?: boolean;
            readonly expectedVersionId?: string;
            readonly tags?: Record<string, string>;
            readonly purgeProtected?: boolean;
          }
        | undefined;

      if (rest === "" && method === "GET") {
        const status = url.searchParams.get("status") ?? "active";
        const search = url.searchParams.get("q")?.toLowerCase() ?? "";
        const san = url.searchParams.get("san");
        const expiresBefore = url.searchParams.get("expiresBefore");
        const expiresAfter = url.searchParams.get("expiresAfter");
        let rows = this.certificates.filter((entry) =>
          status === "deleted" ? entry.status === "deleted" : entry.status !== "deleted",
        );
        if (search.length > 0) {
          rows = rows.filter(
            (entry) =>
              entry.name.toLowerCase().includes(search) ||
              entry.subject.toLowerCase().includes(search),
          );
        }
        if (san !== null) {
          rows = rows.filter((entry) =>
            entry.sans.some((value) => value.toLowerCase() === san.toLowerCase()),
          );
        }
        if (expiresAfter !== null) {
          rows = rows.filter((entry) => Date.parse(entry.notAfter) >= Date.parse(expiresAfter));
        }
        if (expiresBefore !== null) {
          rows = rows.filter((entry) => Date.parse(entry.notAfter) <= Date.parse(expiresBefore));
        }
        const parsedCursor = Number(url.searchParams.get("cursor") ?? "0");
        const cursor = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
        const parsedLimit = Number(url.searchParams.get("limit") ?? "50");
        const limit = Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;
        const page = rows.slice(cursor, cursor + limit);
        const nextCursor = cursor + limit < rows.length ? String(cursor + limit) : null;
        return ok({ certificates: page, nextCursor });
      }

      if (rest === "/import" && method === "POST") {
        if (
          certificateBody?.name === undefined ||
          certificateBody.certificatePem === undefined ||
          certificateBody.privateKeyPem === undefined
        ) {
          return failure(422, "validation_error", "Validation failed");
        }
        return this.#writeCertificate(
          certificateBody.name,
          certificateBody.expectedVersionId,
          "CN=imported.example.test",
          ["DNS:imported.example.test"],
          certificateBody.tags ?? {},
          certificateBody.certificatePem,
          certificateBody.chainPem ?? "",
        );
      }

      if (rest === "/generate" && method === "POST") {
        if (
          certificateBody?.name === undefined ||
          certificateBody.subject === undefined ||
          certificateBody.sans === undefined ||
          certificateBody.sans.length === 0
        ) {
          return failure(422, "validation_error", "Validation failed");
        }
        return this.#writeCertificate(
          certificateBody.name,
          certificateBody.expectedVersionId,
          certificateBody.subject,
          certificateBody.sans,
          certificateBody.tags ?? {},
          TEST_CERTIFICATE_PEM,
          "",
        );
      }

      const nameMatch = /^\/([^/]+)(\/private-key|\/recover|\/purge)?$/.exec(rest);
      if (nameMatch !== null) {
        const certificateName = decodeURIComponent(nameMatch[1] ?? "");
        const suffix = nameMatch[2];
        const found = this.certificates.find((entry) => entry.name === certificateName);

        if (method === "GET" && suffix === "/private-key") {
          if (found === undefined || found.status === "deleted") {
            return failure(404, "certificate_not_found", "Certificate not found");
          }
          this.privateKeyRevealCount += 1;
          if (this.certificateReadGate !== undefined) {
            await this.certificateReadGate;
          }
          if (this.denyPrivateKey) {
            return failure(403, "access_denied", "Access denied");
          }
          return ok({
            id: found.id,
            projectId: found.projectId,
            name: found.name,
            fingerprint: found.fingerprint,
            privateKeyPem: TEST_PRIVATE_KEY_PEM,
            version: found.version,
            capabilities: found.capabilities,
          });
        }

        if (method === "GET" && suffix === undefined) {
          if (found === undefined || found.status === "deleted") {
            return failure(404, "certificate_not_found", "Certificate not found");
          }
          if (url.searchParams.get("version") === null && found.status === "expired") {
            return failure(410, "certificate_expired", "Certificate expired");
          }
          if (this.certificateReadGate !== undefined) {
            await this.certificateReadGate;
          }
          return ok({
            ...found,
            certificatePem: this.certificateLeafPem,
            chainPem: this.certificateChainPem,
          });
        }

        if (method === "PATCH" && suffix === undefined) {
          if (found === undefined) {
            return failure(404, "certificate_not_found", "Certificate not found");
          }
          if (
            certificateBody?.tags === undefined &&
            certificateBody?.purgeProtected === undefined
          ) {
            return failure(422, "validation_error", "Validation failed");
          }
          if (certificateBody.purgeProtected === false && found.purgeProtected) {
            return failure(
              409,
              "purge_protection_locked",
              "Purge protection is on and cannot be turned off.",
            );
          }
          if (certificateBody.tags !== undefined) {
            found.tags = certificateBody.tags;
          }
          if (certificateBody.purgeProtected !== undefined) {
            found.purgeProtected = certificateBody.purgeProtected;
          }
          found.updatedAt = "2026-11-08T12:00:00.000Z";
          return ok(found);
        }

        if (method === "DELETE" && suffix === undefined) {
          if (found === undefined) {
            return failure(404, "certificate_not_found", "Certificate not found");
          }
          found.status = "deleted";
          found.deletedAt = "2026-11-08T12:00:00.000Z";
          found.purgeAfter = "2026-12-08T12:00:00.000Z";
          found.updatedAt = "2026-11-08T12:00:00.000Z";
          return noContent();
        }

        if (method === "POST" && suffix === "/recover") {
          if (found === undefined) {
            return failure(404, "certificate_not_found", "Certificate not found");
          }
          found.status = "active";
          found.deletedAt = null;
          found.purgeAfter = null;
          found.updatedAt = "2026-11-08T12:00:00.000Z";
          return ok(found);
        }

        if (method === "POST" && suffix === "/purge") {
          if (found === undefined) {
            return failure(404, "certificate_not_found", "Certificate not found");
          }
          if (found.status !== "deleted") {
            return failure(409, "certificate_not_deleted", "Certificate is not deleted");
          }
          if (found.purgeProtected) {
            return failure(
              409,
              "purge_protection_locked",
              "Purge protection is on and cannot be turned off.",
            );
          }
          if (found.purgeAfter !== null && Date.parse(found.purgeAfter) > Date.now()) {
            return failure(
              409,
              "certificate_retention_active",
              "The retention period has not ended.",
            );
          }
          this.certificates = this.certificates.filter((entry) => entry.name !== certificateName);
          return noContent();
        }
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
            scopeId: VALUE_ID,
            objectType: "secret",
            objectId: VALUE_ID,
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
