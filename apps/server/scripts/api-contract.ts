import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as api from "@openvault/api-contract";
import {
  type ClientGeneratorOptions,
  type ContractIssue,
  type ControllerConstructor,
  checkClient,
  formatOpenApiDocument,
  generateClient,
  type OpenAPIDocument,
  OpenAPIGenerator,
  type OpenAPIParameter,
  type OpenAPISchema,
} from "blendsdk/codegen";
import type { RouteDefinition } from "blendsdk/webafx";
import { z } from "zod";
import { AccessExplainController, AssignmentsController } from "../src/controllers/assignments.js";
import { AuditController } from "../src/controllers/audit.js";
import { AuthController } from "../src/controllers/auth.js";
import { CertificatesController } from "../src/controllers/certificates.js";
import { CliAuthController } from "../src/controllers/cli-auth.js";
import { IdentityController } from "../src/controllers/identity.js";
import { MetaController } from "../src/controllers/meta.js";
import { ProjectsController } from "../src/controllers/projects.js";
import { ReadyController } from "../src/controllers/ready.js";
import { ScaffoldController } from "../src/controllers/scaffold.js";
import { SecretsController } from "../src/controllers/secrets.js";

/** One documented operation. */
export interface RouteDoc {
  /** Generated method name. */
  readonly operationId: string;
  /** Generated client group. */
  readonly tags: readonly string[];
  /** Human summary for the OpenAPI document. */
  readonly summary: string;
  /** Whether the route requires a bearer token. */
  readonly secure: boolean;
  /** How the client reads a successful body. */
  readonly envelope?: "data" | "body";
  /** Query schema for GET/DELETE, body schema for POST/PUT/PATCH. */
  readonly input?: z.ZodType;
  /** Declared success responses. Every operation must have a 2xx schema. */
  readonly responses: ReadonlyArray<{
    readonly statusCode: number;
    readonly description: string;
    readonly schema?: z.ZodType;
  }>;
}

/** One real controller mounted at its runtime base path. */
export interface ContractController {
  /** Mount path from `app.ts`. */
  readonly basePath: string;
  /** Controller constructor. */
  readonly controller: ControllerConstructor;
}

const NO_CONTENT = z.unknown();

/**
 * The CLI-facing controllers.
 *
 * Internal agent, browser/OIDC, and probe controllers are deliberately absent.
 */
export const CONTRACT_CONTROLLERS: readonly ContractController[] = [
  { basePath: "/v1/auth/cli", controller: CliAuthController },
  { basePath: "/v1/admin/projects", controller: ProjectsController },
  { basePath: "/v1/data", controller: SecretsController },
  { basePath: "/v1/data", controller: CertificatesController },
  { basePath: "/v1/admin/identities", controller: IdentityController },
  { basePath: "/v1/admin/assignments", controller: AssignmentsController },
  { basePath: "/v1/admin/access-explain", controller: AccessExplainController },
  { basePath: "/v1/audit", controller: AuditController },
  { basePath: "/v1/admin/scaffold", controller: ScaffoldController },
  { basePath: "/v1/meta", controller: MetaController },
  { basePath: "", controller: ReadyController },
];

/** Builds one route key from a method and full Express path. */
export function routeKey(method: string, fullPath: string): string {
  return `${method.toUpperCase()} ${fullPath}`;
}

/** Joins one base path and a route path. */
export function joinPath(basePath: string, routePath: string): string {
  const base = basePath.replace(/\/+$/, "");
  if (routePath === "/") {
    return base.length === 0 ? "/" : base;
  }
  return `${base}${routePath.startsWith("/") ? routePath : `/${routePath}`}`;
}

/**
 * The route metadata table.
 *
 * The real controllers own paths and methods. This table owns the documented
 * schemas, operation ids, security, and success responses. A route without an
 * entry, or an entry without a route, fails the contract build.
 */
export const ROUTE_DOCS: Readonly<Record<string, RouteDoc>> = {
  "POST /v1/auth/cli/login": {
    operationId: "loginCli",
    tags: ["auth"],
    summary: "Log in with a local credential and issue a CLI token family",
    secure: false,
    input: api.cliLoginRequestSchema,
    responses: [
      { statusCode: 200, description: "Issued token family", schema: api.cliTokenResponseSchema },
    ],
  },
  "POST /v1/auth/cli/refresh": {
    operationId: "refreshCli",
    tags: ["auth"],
    summary: "Rotate a CLI refresh token",
    secure: false,
    input: api.cliRefreshRequestSchema,
    responses: [
      { statusCode: 200, description: "Rotated token family", schema: api.cliTokenResponseSchema },
    ],
  },
  "POST /v1/auth/cli/logout": {
    operationId: "logoutCli",
    tags: ["auth"],
    summary: "Revoke a CLI refresh family",
    secure: false,
    input: api.cliLogoutRequestSchema,
    responses: [{ statusCode: 204, description: "Revoked", schema: NO_CONTENT }],
  },
  "GET /v1/auth/cli/me": {
    operationId: "getCliMe",
    tags: ["auth"],
    summary: "Read the current CLI user",
    secure: true,
    responses: [{ statusCode: 200, description: "Current user", schema: api.cliMeResponseSchema }],
  },
  "GET /v1/auth/cli/sessions": {
    operationId: "listCliSessions",
    tags: ["auth"],
    summary: "List the current principal's CLI families",
    secure: true,
    responses: [{ statusCode: 200, description: "CLI families", schema: api.cliSessionListSchema }],
  },
  "DELETE /v1/auth/cli/sessions/:familyId": {
    operationId: "revokeCliSession",
    tags: ["auth"],
    summary: "Revoke one owned CLI family",
    secure: true,
    responses: [{ statusCode: 204, description: "Revoked", schema: NO_CONTENT }],
  },

  "GET /v1/admin/projects": {
    operationId: "listProjects",
    tags: ["projects"],
    summary: "List visible projects",
    secure: true,
    responses: [{ statusCode: 200, description: "Project list", schema: api.projectListSchema }],
  },
  "POST /v1/admin/projects": {
    operationId: "createProject",
    tags: ["projects"],
    summary: "Create a project",
    secure: true,
    input: api.projectCreateRequestSchema,
    responses: [{ statusCode: 201, description: "Created project", schema: api.projectSchema }],
  },
  "GET /v1/admin/projects/:project": {
    operationId: "getProject",
    tags: ["projects"],
    summary: "Read a project by id",
    secure: true,
    responses: [{ statusCode: 200, description: "Project", schema: api.projectSchema }],
  },
  "PATCH /v1/admin/projects/:project": {
    operationId: "updateProject",
    tags: ["projects"],
    summary: "Rename a project",
    secure: true,
    input: api.projectUpdateRequestSchema,
    responses: [{ statusCode: 200, description: "Updated project", schema: api.projectSchema }],
  },
  "DELETE /v1/admin/projects/:project": {
    operationId: "deleteProject",
    tags: ["projects"],
    summary: "Soft-delete a project",
    secure: true,
    responses: [{ statusCode: 204, description: "Deleted", schema: NO_CONTENT }],
  },

  "GET /v1/data/:project/secrets": {
    operationId: "listSecrets",
    tags: ["secrets"],
    summary: "List secrets in a project",
    secure: true,
    input: api.secretListQuerySchema,
    responses: [{ statusCode: 200, description: "Secret list", schema: api.secretListSchema }],
  },
  "POST /v1/data/:project/secrets": {
    operationId: "createSecret",
    tags: ["secrets"],
    summary: "Create a secret",
    secure: true,
    input: api.secretCreateRequestSchema,
    responses: [
      { statusCode: 201, description: "Created secret", schema: api.secretWriteResponseSchema },
    ],
  },
  "GET /v1/data/:project/secrets/:name": {
    operationId: "getSecret",
    tags: ["secrets"],
    summary: "Read a secret value",
    secure: true,
    input: api.secretReadQuerySchema,
    responses: [
      { statusCode: 200, description: "Secret value", schema: api.secretValueResponseSchema },
    ],
  },
  "GET /v1/data/:project/secrets/:name/versions": {
    operationId: "listSecretVersions",
    tags: ["secrets"],
    summary: "List secret versions",
    secure: true,
    responses: [
      { statusCode: 200, description: "Version history", schema: api.secretVersionListSchema },
    ],
  },
  "GET /v1/data/:project/secrets/:name/consumers": {
    operationId: "listSecretConsumers",
    tags: ["secrets"],
    summary: "List secret consumers",
    secure: true,
    responses: [
      { statusCode: 200, description: "Consumer list", schema: api.secretConsumerListSchema },
    ],
  },
  "PUT /v1/data/:project/secrets/:name": {
    operationId: "writeSecretValue",
    tags: ["secrets"],
    summary: "Write a new secret version",
    secure: true,
    input: api.secretValueWriteRequestSchema,
    responses: [
      { statusCode: 200, description: "Written version", schema: api.secretWriteResponseSchema },
    ],
  },
  "PATCH /v1/data/:project/secrets/:name": {
    operationId: "updateSecretMetadata",
    tags: ["secrets"],
    summary: "Update secret metadata",
    secure: true,
    input: api.secretMetadataUpdateRequestSchema,
    responses: [
      { statusCode: 200, description: "Updated metadata", schema: api.secretMetadataSchema },
    ],
  },
  "DELETE /v1/data/:project/secrets/:name": {
    operationId: "deleteSecret",
    tags: ["secrets"],
    summary: "Soft-delete a secret",
    secure: true,
    responses: [{ statusCode: 204, description: "Deleted", schema: NO_CONTENT }],
  },
  "POST /v1/data/:project/secrets/:name/recover": {
    operationId: "recoverSecret",
    tags: ["secrets"],
    summary: "Recover a soft-deleted secret",
    secure: true,
    responses: [
      { statusCode: 200, description: "Recovered metadata", schema: api.secretMetadataSchema },
    ],
  },
  "POST /v1/data/:project/secrets/:name/purge": {
    operationId: "purgeSecret",
    tags: ["secrets"],
    summary: "Purge a deleted secret",
    secure: true,
    responses: [{ statusCode: 204, description: "Purged", schema: NO_CONTENT }],
  },

  "GET /v1/data/:project/certificates": {
    operationId: "listCertificates",
    tags: ["certificates"],
    summary: "List certificates in a project",
    secure: true,
    input: api.certificateListQuerySchema,
    responses: [
      { statusCode: 200, description: "Certificate list", schema: api.certificateListSchema },
    ],
  },
  "POST /v1/data/:project/certificates/import": {
    operationId: "importCertificate",
    tags: ["certificates"],
    summary: "Import a certificate and private key",
    secure: true,
    input: api.certificateImportRequestSchema,
    responses: [
      {
        statusCode: 200,
        description: "New certificate version",
        schema: api.certificateWriteResponseSchema,
      },
      {
        statusCode: 201,
        description: "Created certificate",
        schema: api.certificateWriteResponseSchema,
      },
    ],
  },
  "POST /v1/data/:project/certificates/generate": {
    operationId: "generateCertificate",
    tags: ["certificates"],
    summary: "Generate a self-signed certificate",
    secure: true,
    input: api.certificateGenerateRequestSchema,
    responses: [
      {
        statusCode: 200,
        description: "New certificate version",
        schema: api.certificateWriteResponseSchema,
      },
      {
        statusCode: 201,
        description: "Created certificate",
        schema: api.certificateWriteResponseSchema,
      },
    ],
  },
  "GET /v1/data/:project/certificates/:name": {
    operationId: "getCertificate",
    tags: ["certificates"],
    summary: "Read a certificate chain",
    secure: true,
    input: api.certificateReadQuerySchema,
    responses: [
      { statusCode: 200, description: "Public chain", schema: api.certificatePublicResponseSchema },
    ],
  },
  "GET /v1/data/:project/certificates/:name/private-key": {
    operationId: "getCertificatePrivateKey",
    tags: ["certificates"],
    summary: "Read a certificate private key",
    secure: true,
    input: api.certificateReadQuerySchema,
    responses: [
      {
        statusCode: 200,
        description: "Private key",
        schema: api.certificatePrivateKeyResponseSchema,
      },
    ],
  },
  "PATCH /v1/data/:project/certificates/:name": {
    operationId: "updateCertificateMetadata",
    tags: ["certificates"],
    summary: "Update certificate metadata",
    secure: true,
    input: api.certificateMetadataUpdateRequestSchema,
    responses: [
      { statusCode: 200, description: "Updated metadata", schema: api.certificateMetadataSchema },
    ],
  },
  "DELETE /v1/data/:project/certificates/:name": {
    operationId: "deleteCertificate",
    tags: ["certificates"],
    summary: "Soft-delete a certificate",
    secure: true,
    responses: [{ statusCode: 204, description: "Deleted", schema: NO_CONTENT }],
  },
  "POST /v1/data/:project/certificates/:name/recover": {
    operationId: "recoverCertificate",
    tags: ["certificates"],
    summary: "Recover a soft-deleted certificate",
    secure: true,
    responses: [
      { statusCode: 200, description: "Recovered metadata", schema: api.certificateMetadataSchema },
    ],
  },
  "POST /v1/data/:project/certificates/:name/purge": {
    operationId: "purgeCertificate",
    tags: ["certificates"],
    summary: "Purge a deleted certificate",
    secure: true,
    responses: [{ statusCode: 204, description: "Purged", schema: NO_CONTENT }],
  },

  "GET /v1/admin/identities": {
    operationId: "listIdentities",
    tags: ["identities"],
    summary: "List service identities",
    secure: true,
    input: api.identityListQuerySchema,
    responses: [{ statusCode: 200, description: "Identity list", schema: api.identityListSchema }],
  },
  "POST /v1/admin/identities": {
    operationId: "createIdentity",
    tags: ["identities"],
    summary: "Create a service identity",
    secure: true,
    input: api.identityCreateRequestSchema,
    responses: [
      { statusCode: 201, description: "Created identity", schema: api.identitySummarySchema },
    ],
  },
  "GET /v1/admin/identities/:id": {
    operationId: "getIdentity",
    tags: ["identities"],
    summary: "Read a service identity",
    secure: true,
    responses: [
      { statusCode: 200, description: "Identity detail", schema: api.identityDetailSchema },
    ],
  },
  "POST /v1/admin/identities/:id/revoke": {
    operationId: "revokeIdentity",
    tags: ["identities"],
    summary: "Revoke a service identity",
    secure: true,
    responses: [{ statusCode: 204, description: "Revoked", schema: NO_CONTENT }],
  },
  "POST /v1/admin/identities/:id/join-tokens": {
    operationId: "issueJoinToken",
    tags: ["identities"],
    summary: "Issue a one-time join token",
    secure: true,
    input: api.joinTokenCreateRequestSchema,
    responses: [
      { statusCode: 201, description: "Join token", schema: api.joinTokenResponseSchema },
    ],
  },

  "GET /v1/admin/assignments": {
    operationId: "listAssignments",
    tags: ["assignments"],
    summary: "List role assignments",
    secure: true,
    input: api.assignmentListQuerySchema,
    responses: [
      { statusCode: 200, description: "Assignment list", schema: api.assignmentListSchema },
    ],
  },
  "POST /v1/admin/assignments": {
    operationId: "createAssignment",
    tags: ["assignments"],
    summary: "Grant a role assignment",
    secure: true,
    input: api.assignmentCreateRequestSchema,
    responses: [
      { statusCode: 201, description: "Created assignment", schema: api.assignmentSchema },
    ],
  },
  "DELETE /v1/admin/assignments/:id": {
    operationId: "deleteAssignment",
    tags: ["assignments"],
    summary: "Revoke a role assignment",
    secure: true,
    responses: [{ statusCode: 204, description: "Revoked", schema: NO_CONTENT }],
  },

  "GET /v1/admin/access-explain": {
    operationId: "explainAccess",
    tags: ["access"],
    summary: "Explain effective access to one resource",
    secure: true,
    input: api.accessExplainQuerySchema,
    responses: [
      {
        statusCode: 200,
        description: "Access explanation",
        schema: api.accessExplainResponseSchema,
      },
    ],
  },

  "GET /v1/audit/events": {
    operationId: "listAuditEvents",
    tags: ["audit"],
    summary: "Query audit events",
    secure: true,
    input: api.auditQuerySchema,
    responses: [{ statusCode: 200, description: "Event page", schema: api.auditEventListSchema }],
  },
  "GET /v1/audit/verify": {
    operationId: "verifyAudit",
    tags: ["audit"],
    summary: "Verify the audit chain",
    secure: true,
    responses: [
      {
        statusCode: 200,
        description: "Verification result",
        schema: api.auditVerifyResponseSchema,
      },
    ],
  },
  "GET /v1/audit/export": {
    operationId: "exportAudit",
    tags: ["audit"],
    summary: "Export matching audit events as NDJSON",
    secure: true,
    input: api.auditExportQuerySchema,
    responses: [{ statusCode: 200, description: "NDJSON stream", schema: z.string() }],
  },

  "POST /v1/admin/scaffold": {
    operationId: "createScaffold",
    tags: ["scaffold"],
    summary: "Create or reuse a Compose service scaffold",
    secure: true,
    input: api.scaffoldRequestSchema,
    responses: [
      { statusCode: 200, description: "Scaffold result", schema: api.scaffoldResponseSchema },
    ],
  },

  "GET /v1/meta/auth": {
    operationId: "getAuthCapabilities",
    tags: ["meta"],
    summary: "Read available login methods",
    secure: false,
    responses: [{ statusCode: 200, description: "Auth capabilities", schema: api.metaAuthSchema }],
  },
  "GET /v1/meta/roles": {
    operationId: "getRoleCatalog",
    tags: ["meta"],
    summary: "Read the role and action catalog",
    secure: false,
    responses: [{ statusCode: 200, description: "Role catalog", schema: api.roleCatalogSchema }],
  },
  "GET /ready": {
    operationId: "getReadiness",
    tags: ["meta"],
    summary: "Check dependency readiness",
    secure: false,
    responses: [
      {
        statusCode: 200,
        description: "Ready",
        schema: z.strictObject({ status: z.literal("ready") }),
      },
    ],
  },
};

/** One browser controller mounted at its runtime base path. */
export interface WebContractController {
  /** Mount path from `app.ts`. */
  readonly basePath: string;
  /** Controller constructor. */
  readonly controller: ControllerConstructor;
}

/**
 * The browser-facing controllers.
 *
 * OIDC redirect/callback, certificates, scaffold, agent, and readiness routes
 * are deliberately absent. OIDC is a browser navigation, not a JSON call.
 */
export const WEB_CONTRACT_CONTROLLERS: readonly WebContractController[] = [
  { basePath: "/v1/auth", controller: AuthController },
  { basePath: "/v1/meta", controller: MetaController },
  { basePath: "/v1/admin/projects", controller: ProjectsController },
  { basePath: "/v1/data", controller: SecretsController },
  { basePath: "/v1/admin/identities", controller: IdentityController },
  { basePath: "/v1/admin/assignments", controller: AssignmentsController },
  { basePath: "/v1/admin/access-explain", controller: AccessExplainController },
  { basePath: "/v1/audit", controller: AuditController },
];

/** Returns one existing route document, or fails the build. */
function sharedRouteDoc(key: string): RouteDoc {
  const doc = ROUTE_DOCS[key];
  if (doc === undefined) {
    throw new Error(`The web contract expects a missing route document: ${key}`);
  }
  return doc;
}

/**
 * Browser route metadata.
 *
 * Shared project, secret, identity, assignment, access, audit, and meta
 * entries reuse the CLI documents. The browser-only session routes are added
 * here.
 */
export const WEB_ROUTE_DOCS: Readonly<Record<string, RouteDoc>> = {
  "POST /v1/auth/local/login": {
    operationId: "loginLocal",
    tags: ["session"],
    summary: "Log in with a local credential and start a browser session",
    secure: false,
    input: api.loginRequestSchema,
    responses: [
      { statusCode: 200, description: "Browser session", schema: api.sessionResponseSchema },
    ],
  },
  "POST /v1/auth/password": {
    operationId: "changePassword",
    tags: ["session"],
    summary: "Change the current password and rotate the session",
    secure: true,
    input: api.passwordChangeRequestSchema,
    responses: [
      { statusCode: 200, description: "Rotated session", schema: api.refreshResponseSchema },
    ],
  },
  "GET /v1/auth/me": {
    operationId: "getMe",
    tags: ["session"],
    summary: "Read the current browser session",
    secure: true,
    responses: [
      { statusCode: 200, description: "Current session", schema: api.sessionResponseSchema },
    ],
  },
  "POST /v1/auth/refresh": {
    operationId: "refreshSession",
    tags: ["session"],
    summary: "Rotate the browser session and CSRF token",
    secure: true,
    responses: [
      { statusCode: 200, description: "Rotated session", schema: api.refreshResponseSchema },
    ],
  },
  "POST /v1/auth/logout": {
    operationId: "logoutSession",
    tags: ["session"],
    summary: "Revoke the current browser session",
    secure: true,
    responses: [{ statusCode: 204, description: "Revoked", schema: NO_CONTENT }],
  },
  "GET /v1/auth/sessions": {
    operationId: "listSessions",
    tags: ["session"],
    summary: "List the current principal's browser sessions",
    secure: true,
    responses: [{ statusCode: 200, description: "Sessions", schema: api.sessionListSchema }],
  },
  "DELETE /v1/auth/sessions/:id": {
    operationId: "revokeSession",
    tags: ["session"],
    summary: "Revoke one owned browser session",
    secure: true,
    responses: [{ statusCode: 204, description: "Revoked", schema: NO_CONTENT }],
  },

  "GET /v1/meta/auth": sharedRouteDoc("GET /v1/meta/auth"),
  "GET /v1/meta/roles": sharedRouteDoc("GET /v1/meta/roles"),

  "GET /v1/admin/projects": sharedRouteDoc("GET /v1/admin/projects"),
  "POST /v1/admin/projects": sharedRouteDoc("POST /v1/admin/projects"),
  "GET /v1/admin/projects/:project": sharedRouteDoc("GET /v1/admin/projects/:project"),
  "PATCH /v1/admin/projects/:project": sharedRouteDoc("PATCH /v1/admin/projects/:project"),
  "DELETE /v1/admin/projects/:project": sharedRouteDoc("DELETE /v1/admin/projects/:project"),

  "GET /v1/data/:project/secrets": sharedRouteDoc("GET /v1/data/:project/secrets"),
  "POST /v1/data/:project/secrets": sharedRouteDoc("POST /v1/data/:project/secrets"),
  "GET /v1/data/:project/secrets/:name": sharedRouteDoc("GET /v1/data/:project/secrets/:name"),
  "GET /v1/data/:project/secrets/:name/versions": sharedRouteDoc(
    "GET /v1/data/:project/secrets/:name/versions",
  ),
  "GET /v1/data/:project/secrets/:name/consumers": sharedRouteDoc(
    "GET /v1/data/:project/secrets/:name/consumers",
  ),
  "PUT /v1/data/:project/secrets/:name": sharedRouteDoc("PUT /v1/data/:project/secrets/:name"),
  "PATCH /v1/data/:project/secrets/:name": sharedRouteDoc("PATCH /v1/data/:project/secrets/:name"),
  "DELETE /v1/data/:project/secrets/:name": sharedRouteDoc(
    "DELETE /v1/data/:project/secrets/:name",
  ),
  "POST /v1/data/:project/secrets/:name/recover": sharedRouteDoc(
    "POST /v1/data/:project/secrets/:name/recover",
  ),
  "POST /v1/data/:project/secrets/:name/purge": sharedRouteDoc(
    "POST /v1/data/:project/secrets/:name/purge",
  ),

  "GET /v1/admin/identities": sharedRouteDoc("GET /v1/admin/identities"),
  "POST /v1/admin/identities": sharedRouteDoc("POST /v1/admin/identities"),
  "GET /v1/admin/identities/:id": sharedRouteDoc("GET /v1/admin/identities/:id"),
  "POST /v1/admin/identities/:id/revoke": sharedRouteDoc("POST /v1/admin/identities/:id/revoke"),
  "POST /v1/admin/identities/:id/join-tokens": sharedRouteDoc(
    "POST /v1/admin/identities/:id/join-tokens",
  ),

  "GET /v1/admin/assignments": sharedRouteDoc("GET /v1/admin/assignments"),
  "POST /v1/admin/assignments": sharedRouteDoc("POST /v1/admin/assignments"),
  "DELETE /v1/admin/assignments/:id": sharedRouteDoc("DELETE /v1/admin/assignments/:id"),

  "GET /v1/admin/access-explain": sharedRouteDoc("GET /v1/admin/access-explain"),

  "GET /v1/audit/events": sharedRouteDoc("GET /v1/audit/events"),
  "GET /v1/audit/verify": sharedRouteDoc("GET /v1/audit/verify"),
  "GET /v1/audit/export": sharedRouteDoc("GET /v1/audit/export"),
};

/** Instruments one real route with documentation metadata. */
export function documentRoute(
  basePath: string,
  definition: RouteDefinition,
  docs: Readonly<Record<string, RouteDoc>> = ROUTE_DOCS,
): RouteDefinition {
  const key = routeKey(definition.method, joinPath(basePath, definition.path));
  const doc = docs[key];
  if (doc === undefined) {
    throw new Error(`Missing API documentation for ${key}`);
  }
  return {
    method: definition.method,
    path: definition.path,
    handler: () => undefined,
    secure: doc.secure,
    ...(doc.input === undefined ? {} : { validation: doc.input }),
    openapi: {
      operationId: doc.operationId,
      tags: [...doc.tags],
      summary: doc.summary,
      ...(doc.envelope === undefined ? {} : { envelope: doc.envelope }),
      responses: doc.responses.map((response) => ({
        statusCode: response.statusCode,
        description: response.description,
        ...(response.schema === undefined ? {} : { schema: response.schema }),
      })),
    },
  };
}

/** Returns true for a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Converts one raw JSON Schema node into the OpenAPI schema subset. */
function toOpenApiSchema(value: unknown): OpenAPISchema {
  if (!isRecord(value)) {
    return {};
  }
  const result: OpenAPISchema = {};
  if (typeof value.type === "string") {
    result.type = value.type;
  } else if (Array.isArray(value.type) && value.type.every((entry) => typeof entry === "string")) {
    result.type = value.type.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value.description === "string") {
    result.description = value.description;
  }
  if (typeof value.format === "string") {
    result.format = value.format;
  }
  if (Array.isArray(value.enum)) {
    result.enum = [...value.enum];
  }
  if (value.default !== undefined) {
    result.default = value.default;
  }
  if (isRecord(value.properties)) {
    const properties: Record<string, OpenAPISchema> = {};
    for (const [name, property] of Object.entries(value.properties)) {
      properties[name] = toOpenApiSchema(property);
    }
    result.properties = properties;
  }
  if (Array.isArray(value.required) && value.required.every((entry) => typeof entry === "string")) {
    result.required = value.required.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value.additionalProperties === "boolean") {
    result.additionalProperties = value.additionalProperties;
  } else if (isRecord(value.additionalProperties)) {
    result.additionalProperties = toOpenApiSchema(value.additionalProperties);
  }
  if (value.items !== undefined) {
    result.items = toOpenApiSchema(value.items);
  }
  for (const key of [
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
  ] as const) {
    if (typeof value[key] === "number") {
      result[key] = value[key];
    }
  }
  if (typeof value.pattern === "string") {
    result.pattern = value.pattern;
  }
  if (value.const !== undefined) {
    result.const = value.const;
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(value[key])) {
      result[key] = value[key].map((entry) => toOpenApiSchema(entry));
    }
  }
  return result;
}

/** Finds the object schema inside one converted query schema. */
function queryObject(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.type === "object" || isRecord(value.properties)) {
    return value;
  }
  if (Array.isArray(value.anyOf)) {
    return value.anyOf.map((entry) => queryObject(entry)).find((entry) => entry !== undefined);
  }
  return undefined;
}

/** Splits one query schema into OpenAPI parameters without dangling `$defs`. */
function queryParameters(schema: z.ZodType): OpenAPIParameter[] {
  const raw = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  });
  const object = queryObject(raw);
  if (object === undefined || !isRecord(object.properties)) {
    return [];
  }
  const required = new Set(
    Array.isArray(object.required)
      ? object.required.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
  return Object.entries(object.properties).map(([name, property]) => ({
    name,
    in: "query" as const,
    ...(required.has(name) ? { required: true } : {}),
    schema: toOpenApiSchema(property),
  }));
}

/**
 * Rebuilds GET/DELETE query parameters without the generator's `reused: "ref"`
 * definitions, which it drops from the parameter object and leaves dangling.
 */
function applyQueryParameters(
  document: OpenAPIDocument,
  docs: Readonly<Record<string, RouteDoc>> = ROUTE_DOCS,
): void {
  const byPath = new Map<string, RouteDoc>();
  for (const [key, doc] of Object.entries(docs)) {
    const separator = key.indexOf(" ");
    const method = key.slice(0, separator);
    const expressPath = key.slice(separator + 1).replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
    byPath.set(`${method} ${expressPath}`, doc);
  }
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of ["get", "delete"] as const) {
      const operation = item[method];
      if (operation === undefined) {
        continue;
      }
      const doc = byPath.get(`${method.toUpperCase()} ${path}`);
      if (doc?.input === undefined) {
        continue;
      }
      const pathParameters = (operation.parameters ?? []).filter(
        (parameter) => parameter.in === "path",
      );
      operation.parameters = [...pathParameters, ...queryParameters(doc.input)];
    }
  }
}

/**
 * Builds the CLI OpenAPI document from the real controllers.
 *
 * @returns The OpenAPI 3.1 document.
 * @throws {Error} When a real route lacks metadata or a metadata entry has no route.
 */
export async function buildApiDocument(): Promise<OpenAPIDocument> {
  const generator = new OpenAPIGenerator({
    title: "OpenVault CLI API",
    version: "0.1.0",
    description: "The CLI-facing OpenVault API. Internal agent and browser routes are excluded.",
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
    defaultSecurity: [{ bearerAuth: [] }],
  });
  const used = new Set<string>();
  for (const registration of CONTRACT_CONTROLLERS) {
    const controller = new registration.controller({}, {});
    const routes = controller.routes().map((definition) => {
      const key = routeKey(definition.method, joinPath(registration.basePath, definition.path));
      if (used.has(key)) {
        throw new Error(`Duplicate documented route ${key}`);
      }
      used.add(key);
      return documentRoute(registration.basePath, definition);
    });
    generator.addRoutes(registration.basePath, routes);
  }
  const missing = Object.keys(ROUTE_DOCS).filter((key) => !used.has(key));
  if (missing.length > 0) {
    throw new Error(`Documented routes do not exist: ${missing.join(", ")}`);
  }
  const document = generator.generate();
  applyQueryParameters(document);
  return document;
}

/**
 * Builds the browser OpenAPI document from the real browser controllers.
 *
 * The document is in-memory only. The published JSON artifact remains the
 * CLI-facing contract, because the browser authenticates with a cookie and a
 * CSRF header rather than a bearer token.
 *
 * @returns The browser OpenAPI 3.1 document.
 * @throws {Error} When a real route lacks metadata or a metadata entry has no route.
 */
export async function buildWebApiDocument(): Promise<OpenAPIDocument> {
  const generator = new OpenAPIGenerator({
    title: "OpenVault Browser API",
    version: "0.1.0",
    description: "The cookie-session OpenVault API used by the web UI.",
    securitySchemes: {
      cookieAuth: { type: "apiKey", in: "cookie", name: "__Host-ov_session" },
    },
    defaultSecurity: [{ cookieAuth: [] }],
  });
  const used = new Set<string>();
  for (const registration of WEB_CONTRACT_CONTROLLERS) {
    const controller = new registration.controller({}, {});
    const routes = controller.routes().map((definition) => {
      const key = routeKey(definition.method, joinPath(registration.basePath, definition.path));
      if (used.has(key)) {
        throw new Error(`Duplicate documented route ${key}`);
      }
      used.add(key);
      return documentRoute(registration.basePath, definition, WEB_ROUTE_DOCS);
    });
    generator.addRoutes(registration.basePath, routes);
  }
  const missing = Object.keys(WEB_ROUTE_DOCS).filter((key) => !used.has(key));
  if (missing.length > 0) {
    throw new Error(`Documented web routes do not exist: ${missing.join(", ")}`);
  }
  const document = generator.generate();
  applyQueryParameters(document, WEB_ROUTE_DOCS);
  return document;
}

/** Client generation options for one generated client. */
function clientOptions(outputDir: string, clientName = "OpenVaultClient"): ClientGeneratorOptions {
  return {
    outputDir,
    splitByGroup: true,
    clientName,
    runtimeImport: "blendsdk/api-client",
  };
}

/** Resolves the repository root from this script's location. */
function repositoryRoot(): string {
  return fileURLToPath(new URL("../../..", import.meta.url));
}

/** Default artifact paths. */
function defaultArtifacts(): {
  readonly outputDir: string;
  readonly contractFile: string;
  readonly webOutputDir: string;
} {
  const root = repositoryRoot();
  return {
    outputDir: join(root, "apps/cli/src/generated"),
    contractFile: join(root, "packages/api-contract/openapi.json"),
    webOutputDir: join(root, "apps/web/src/generated"),
  };
}

/**
 * Writes the OpenAPI document and the generated client.
 *
 * @param options - Explicit output directory and contract path.
 */
export async function generateContract(options: {
  readonly outputDir: string;
  readonly contractFile: string;
  readonly webOutputDir?: string;
}): Promise<void> {
  const document = await buildApiDocument();
  const result = await generateClient(document, clientOptions(options.outputDir));
  const text = await formatOpenApiDocument(document);
  await mkdir(dirname(options.contractFile), { recursive: true });
  await writeFile(options.contractFile, text, "utf8");
  if (result.issues.length > 0) {
    for (const issue of result.issues) {
      process.stderr.write(`${issue.severity.toUpperCase()}: ${issue.message}\n`);
    }
  }
  if (options.webOutputDir !== undefined) {
    const webDocument = await buildWebApiDocument();
    const webResult = await generateClient(
      webDocument,
      clientOptions(options.webOutputDir, "OpenVaultWebClient"),
    );
    if (webResult.issues.length > 0) {
      for (const issue of webResult.issues) {
        process.stderr.write(`WEB ${issue.severity.toUpperCase()}: ${issue.message}\n`);
      }
    }
  }
}

/**
 * Checks both artifacts without writing.
 *
 * @param options - Explicit output directory and contract path.
 * @returns Drifted files and contract issues.
 */
export async function checkContract(options: {
  readonly outputDir: string;
  readonly contractFile: string;
  readonly webOutputDir?: string;
}): Promise<{
  readonly driftedFiles: readonly string[];
  readonly issues: readonly ContractIssue[];
  readonly hasErrors: boolean;
}> {
  const document = await buildApiDocument();
  const expected = await formatOpenApiDocument(document);
  const drifted = new Set<string>();
  let actual: string | undefined;
  try {
    actual = await readFile(options.contractFile, "utf8");
  } catch {
    actual = undefined;
  }
  if (actual !== expected) {
    drifted.add(options.contractFile);
  }
  const result = await checkClient(document, clientOptions(options.outputDir));
  for (const file of result.driftedFiles ?? []) {
    drifted.add(file);
  }
  const issues = [...result.issues];
  if (options.webOutputDir !== undefined) {
    const webDocument = await buildWebApiDocument();
    const webResult = await checkClient(
      webDocument,
      clientOptions(options.webOutputDir, "OpenVaultWebClient"),
    );
    for (const file of webResult.driftedFiles ?? []) {
      drifted.add(file);
    }
    issues.push(...webResult.issues);
  }
  return {
    driftedFiles: [...drifted].sort(),
    issues,
    hasErrors: issues.some((issue) => issue.severity === "error"),
  };
}

/** Runs one CLI invocation. */
async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if (command !== "generate" && command !== "check") {
    process.stderr.write("Usage: tsx scripts/api-contract.ts <generate|check>\n");
    return 2;
  }
  try {
    const artifacts = defaultArtifacts();
    if (command === "generate") {
      await generateContract(artifacts);
      process.stdout.write(
        "GENERATED openapi.json apps/cli/src/generated apps/web/src/generated\n",
      );
      return 0;
    }
    const result = await checkContract(artifacts);
    for (const issue of result.issues) {
      process.stderr.write(`${issue.severity.toUpperCase()}: ${issue.message}\n`);
    }
    if (result.hasErrors || result.driftedFiles.length > 0) {
      if (result.hasErrors) {
        process.stderr.write("CONTRACT: one or more generated-client errors were reported\n");
      }
      if (result.driftedFiles.length > 0) {
        process.stderr.write(`DRIFT: ${result.driftedFiles.join(", ")}\n`);
      }
      return 1;
    }
    process.stdout.write("CLEAN\n");
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "API contract failed"}\n`);
    return 2;
  }
}

/* c8 ignore start -- exercised only when the script is executed directly. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
/* c8 ignore stop */
