import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import { AuditExporter } from "../../../src/audit/audit-export.js";
import { AuditEventQuery } from "../../../src/audit/audit-query.js";
import { AuditService } from "../../../src/audit/audit-service.js";
import { AuditVerifier } from "../../../src/audit/audit-verify.js";
import { AuditWriter } from "../../../src/audit/audit-writer.js";
import { PersistentPolicyAudit } from "../../../src/audit/policy-audit.js";
import type { AuditEventDraft, AuditEventRecord } from "../../../src/audit/types.js";
import { PolicyRepository } from "../../../src/rbac/policy-repository.js";
import { PolicyService } from "../../../src/rbac/policy-service.js";
import type { KeyringProvider } from "../../../src/security/keyring.js";
import { type BaseFixture, testUlid } from "./fixtures.js";
import type { TestDatabase } from "./test-database.js";

const AUDIT_TRIGGERS = [
  ["audit_events", "audit_events_no_update"],
  ["audit_events", "audit_events_no_delete"],
  ["audit_events", "audit_events_no_truncate"],
  ["audit_checkpoints", "audit_checkpoints_no_update"],
  ["audit_checkpoints", "audit_checkpoints_no_delete"],
  ["audit_checkpoints", "audit_checkpoints_no_truncate"],
] as const;

/** Fixed actors and projects used by audit API tests. */
export interface AuditActors {
  /** Organization administrator with audit.read. */
  readonly orgAdmin: string;
  /** Project auditor for the base project. */
  readonly projectAuditor: string;
  /** Project auditor for the second project. */
  readonly otherAuditor: string;
  /** Authenticated user without audit.read. */
  readonly noAccess: string;
  /** Second project identifier. */
  readonly projectB: string;
}

/** Collaborators used by audit API tests. */
export interface AuditHarness {
  readonly writer: AuditWriter;
  readonly adapter: PersistentPolicyAudit;
  readonly policy: PolicyService;
  readonly service: AuditService;
  readonly query: AuditEventQuery;
  readonly verifier: AuditVerifier;
  readonly exporter: AuditExporter;
}

/** Empties the audit tables without weakening the append-only contract. */
export async function resetAuditTables(database: PostgreSQLDatabase): Promise<void> {
  for (const [table, trigger] of AUDIT_TRIGGERS) {
    await database.executeQuery(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  }
  try {
    await database.executeQuery(
      "TRUNCATE audit_events, audit_checkpoints, audit_keys, audit_prune_receipts, audit_prune_authorizations RESTART IDENTITY",
    );
  } finally {
    for (const [table, trigger] of AUDIT_TRIGGERS) {
      await database.executeQuery(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
  }
}

/** Inserts one user and returns its id. */
async function insertUser(
  database: PostgreSQLDatabase,
  id: string,
  label: string,
): Promise<string> {
  await database.executeQuery(
    `INSERT INTO principals (id, kind, name, email, status)
     VALUES (:id, 'user', :name, :email, 'active')`,
    { id, name: label, email: `${id.toLowerCase()}@example.test` },
  );
  return id;
}

/** Inserts one role assignment. */
async function assign(
  database: PostgreSQLDatabase,
  principalId: string,
  role: string,
  scopeType: "org" | "project",
  scopeId: string,
): Promise<void> {
  await database.executeQuery(
    `INSERT INTO role_assignments (id, principal_id, role, scope_type, scope_id, granted_by)
     VALUES (:id, :principalId, :role, :scopeType, :scopeId, :principalId)`,
    { id: newUlid(), principalId, role, scopeType, scopeId },
  );
}

/**
 * Seeds an organization admin, two project auditors, and a user without access.
 *
 * @param database - Migrated test database.
 * @param base - Base fixture project and principals.
 * @returns Actor identifiers.
 */
export async function seedAuditActors(
  database: PostgreSQLDatabase,
  base: BaseFixture,
): Promise<AuditActors> {
  const projectB = testUlid(9_001);
  await database.executeQuery("INSERT INTO projects (id, name) VALUES (:id, 'audit-b')", {
    id: projectB,
  });
  const orgAdmin = await insertUser(database, testUlid(9_101), "Audit Org Admin");
  const projectAuditor = await insertUser(database, testUlid(9_102), "Audit Project Auditor");
  const otherAuditor = await insertUser(database, testUlid(9_103), "Audit Other Auditor");
  const noAccess = await insertUser(database, testUlid(9_104), "Audit No Access");
  await assign(database, orgAdmin, "org.admin", "org", "org");
  await assign(database, projectAuditor, "auditor", "project", base.projectId);
  await assign(database, otherAuditor, "auditor", "project", projectB);
  return { orgAdmin, projectAuditor, otherAuditor, noAccess, projectB };
}

/**
 * Builds the audit service graph against a real database and keyring.
 *
 * @param testDb - Disposable migrated database.
 * @param keyring - Loaded keyring.
 * @param now - Deterministic clock.
 * @returns The collaborators.
 */
export function createAuditHarness(
  testDb: TestDatabase,
  keyring: KeyringProvider,
  now: () => number,
): AuditHarness {
  const writer = new AuditWriter({ database: testDb.db, keyring, now });
  const adapter = new PersistentPolicyAudit({ writer, database: testDb.db, now });
  const repository = new PolicyRepository(testDb.db);
  const policy = new PolicyService({ repository, audit: adapter });
  const query = new AuditEventQuery({ database: testDb.db, keyring });
  const verifier = new AuditVerifier({ database: testDb.db, keyring });
  const exporter = new AuditExporter({ database: testDb.db, keyring });
  const service = new AuditService({ writer, query, verifier, exporter, policy, now });
  return { writer, adapter, policy, service, query, verifier, exporter };
}

/**
 * Builds one project-scoped event draft.
 *
 * @param base - Base fixture.
 * @param overrides - Fields to replace.
 * @returns A complete draft.
 */
export function auditDraft(
  base: BaseFixture,
  overrides: Partial<AuditEventDraft> = {},
): AuditEventDraft {
  return {
    projectId: base.projectId,
    requestId: "audit-test",
    actorId: base.userId,
    actorKind: "user",
    action: "project.read",
    scopeType: "project",
    scopeId: base.projectId,
    objectType: "project",
    objectId: base.projectId,
    result: "allow",
    sourceIp: null,
    userAgent: null,
    details: { reason: "allowed" },
    ...overrides,
  };
}

/**
 * Records one event through the service.
 *
 * @param harness - Audit harness.
 * @param base - Base fixture.
 * @param overrides - Fields to replace.
 * @returns The persisted record.
 */
export async function recordEvent(
  harness: AuditHarness,
  base: BaseFixture,
  overrides: Partial<AuditEventDraft> = {},
): Promise<AuditEventRecord> {
  return harness.service.record(auditDraft(base, overrides));
}
