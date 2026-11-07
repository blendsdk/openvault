import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PostgreSQLDatabase } from "blendsdk/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliSessionRepository } from "../../../src/auth/cli-sessions.js";
import { CredentialsRepository } from "../../../src/auth/credentials.js";
import { LocalLoginService } from "../../../src/auth/local-login.js";
import { hashPassword } from "../../../src/auth/password.js";
import {
  AuthPrivilegeError,
  assertControlPlaneSeparation,
  CONTROL_PLANE_TABLES,
} from "../../../src/db/privileges.js";
import { PolicyRepository } from "../../../src/rbac/policy-repository.js";
import { type AuditActors, seedAuditActors } from "../helpers/audit-harness.js";
import { type BaseFixture, seedBase, testUlid } from "../helpers/fixtures.js";
import {
  applyMigrations,
  createTestDatabase,
  type TestDatabase,
} from "../helpers/test-database.js";

const ROLE_PASSWORD = randomBytes(18).toString("base64url");
const APP_PASSWORD = "app-password";
const SHARED_PASSWORD = "test-password";
const ROLES = [
  ["openvault_migrator", ROLE_PASSWORD],
  ["openvault_app", APP_PASSWORD],
  ["openvault_auth", ROLE_PASSWORD],
  ["openvault_backup", SHARED_PASSWORD],
  ["openvault_purger", SHARED_PASSWORD],
  ["openvault_pruner", SHARED_PASSWORD],
] as const;

let testDb: TestDatabase;
let base: BaseFixture;
let actors: AuditActors;
let appDb: PostgreSQLDatabase;
let authDb: PostgreSQLDatabase;
let backupDb: PostgreSQLDatabase;
let migratorDb: PostgreSQLDatabase;

function connectionFor(url: string, user: string, password: string): PostgreSQLDatabase {
  const parsed = new URL(url);
  return new PostgreSQLDatabase({
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    user,
    pass: password,
  });
}

async function ensureRole(admin: Client, name: string, password: string): Promise<void> {
  const existing = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
  if (existing.rowCount === 0) {
    await admin.query(
      `CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}'`,
    );
  } else {
    await admin.query(`ALTER ROLE ${name} PASSWORD '${password}'`);
  }
}

async function connectionString(url: string, user: string, password: string): Promise<string> {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await applyMigrations(testDb);
  base = await seedBase(testDb.db);
  actors = await seedAuditActors(testDb.db, base);

  const admin = new Client({ connectionString: testDb.url });
  await admin.connect();
  try {
    const existing = await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname = ANY($1)",
      [["openvault_app", "openvault_auth"]],
    );
    if ((existing.rowCount ?? 0) > 0 && process.env.OPENVAULT_TEST_DISPOSABLE_ROLES !== "1") {
      throw new Error(
        "refusing to reset production role names; set OPENVAULT_TEST_DISPOSABLE_ROLES=1 in a disposable cluster",
      );
    }
    for (const [role, password] of ROLES) {
      await ensureRole(admin, role, password);
    }
    await admin.query("ALTER SCHEMA public OWNER TO openvault_migrator");
    await admin.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
        LOOP
          EXECUTE format('ALTER TABLE public.%I OWNER TO openvault_migrator', r.tablename);
        END LOOP;
      END $$;
    `);
    await admin.query("ALTER VIEW public.secret_consumer_summaries OWNER TO openvault_migrator");
    await admin.query(
      "ALTER FUNCTION public.openvault_prune_audit_prefix(text) OWNER TO openvault_migrator",
    );
  } finally {
    await admin.end();
  }

  const migratorUrl = await connectionString(testDb.url, "openvault_migrator", ROLE_PASSWORD);
  migratorDb = connectionFor(testDb.url, "openvault_migrator", ROLE_PASSWORD);
  const grants = readFileSync(
    fileURLToPath(new URL("../../../../../deploy/postgres/grants.sql", import.meta.url)),
    "utf8",
  )
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n");
  const grantClient = new Client({ connectionString: migratorUrl });
  await grantClient.connect();
  try {
    await grantClient.query(grants);
  } finally {
    await grantClient.end();
  }

  appDb = connectionFor(testDb.url, "openvault_app", APP_PASSWORD);
  authDb = connectionFor(testDb.url, "openvault_auth", ROLE_PASSWORD);
  backupDb = connectionFor(testDb.url, "openvault_backup", SHARED_PASSWORD);
}, 60_000);

afterAll(async () => {
  await appDb?.disconnect();
  await authDb?.disconnect();
  await backupDb?.disconnect();
  await migratorDb?.disconnect();
  await testDb.cleanup();
});

describe("control-plane database boundary", () => {
  it("should deny every write on the eight control-plane tables to the app role", async () => {
    for (const table of CONTROL_PLANE_TABLES) {
      for (const verb of ["INSERT", "UPDATE", "DELETE"]) {
        const result = await appDb.executeQuery<{ allowed: boolean }>(
          "SELECT has_table_privilege(current_user, :table, :verb) AS allowed",
          { table, verb },
        );
        expect(result.records[0]?.allowed, `${verb} on ${table}`).toBe(false);
      }
    }
  });

  it("should remove app writes from policy_state and project hard-delete", async () => {
    for (const verb of ["INSERT", "UPDATE", "DELETE"]) {
      const result = await appDb.executeQuery<{ allowed: boolean }>(
        "SELECT has_table_privilege(current_user, 'policy_state', :verb) AS allowed",
        { verb },
      );
      expect(result.records[0]?.allowed, `policy_state ${verb}`).toBe(false);
    }
    const deleteProject = await appDb.executeQuery<{ allowed: boolean }>(
      "SELECT has_table_privilege(current_user, 'projects', 'DELETE') AS allowed",
    );
    expect(deleteProject.records[0]?.allowed).toBe(false);
  });

  it("should grant every control-plane write to the auth role", async () => {
    for (const table of CONTROL_PLANE_TABLES) {
      for (const verb of ["INSERT", "UPDATE", "DELETE"]) {
        const result = await authDb.executeQuery<{ allowed: boolean }>(
          "SELECT has_table_privilege(current_user, :table, :verb) AS allowed",
          { table, verb },
        );
        expect(result.records[0]?.allowed, `${verb} on ${table}`).toBe(true);
      }
    }
  });

  it("should deny app reads on control-plane tables and allow the backup role", async () => {
    for (const table of [...CONTROL_PLANE_TABLES, "policy_state", "org"]) {
      const result = await appDb.executeQuery<{ readonly allowed: boolean }>(
        "SELECT has_table_privilege(current_user, :table, 'SELECT') AS allowed",
        { table },
      );
      expect(result.records[0]?.allowed, `app SELECT on ${table}`).toBe(false);
    }
    const view = await appDb.executeQuery<{ readonly allowed: boolean }>(
      "SELECT has_table_privilege(current_user, 'secret_consumer_summaries', 'SELECT') AS allowed",
    );
    expect(view.records[0]?.allowed).toBe(true);
    for (const table of [...CONTROL_PLANE_TABLES, "audit_events", "secret_consumer_summaries"]) {
      const result = await backupDb.executeQuery<{ readonly allowed: boolean }>(
        "SELECT has_table_privilege(current_user, :table, 'SELECT') AS allowed",
        { table },
      );
      expect(result.records[0]?.allowed, `backup SELECT on ${table}`).toBe(true);
    }
    const write = await backupDb.executeQuery<{ readonly allowed: boolean }>(
      "SELECT has_table_privilege(current_user, 'projects', 'INSERT') AS allowed",
    );
    expect(write.records[0]?.allowed).toBe(false);
  });

  it("should keep the consumer view restricted and remove app default privileges", async () => {
    const owner = await testDb.db.executeQuery<{ readonly viewowner: string }>(
      `SELECT viewowner FROM pg_views
        WHERE schemaname = 'public' AND viewname = 'secret_consumer_summaries'`,
    );
    expect(owner.records[0]?.viewowner).toBe("openvault_migrator");
    const columns = await testDb.db.executeQuery<{ readonly column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'secret_consumer_summaries'
        ORDER BY ordinal_position`,
    );
    expect(columns.records.map((row) => row.column_name)).toEqual([
      "secret_id",
      "project_id",
      "compose_project",
      "compose_service",
      "last_seen",
    ]);
    const defaults = await testDb.db.executeQuery<{ readonly count: number }>(
      `SELECT count(*)::int AS count
         FROM pg_default_acl d
         JOIN pg_roles r ON r.oid = d.defaclrole
        WHERE r.rolname = 'openvault_migrator'
          AND d.defaclobjtype = 'r'
          AND d.defaclacl::text LIKE '%openvault_app=%'`,
    );
    expect(defaults.records[0]?.count).toBe(0);
    const authorizationInsert = await appDb.executeQuery<{ readonly allowed: boolean }>(
      "SELECT has_table_privilege(current_user, 'audit_prune_authorizations', 'INSERT') AS allowed",
    );
    expect(authorizationInsert.records[0]?.allowed).toBe(true);
    const receiptSelect = await appDb.executeQuery<{ readonly allowed: boolean }>(
      "SELECT has_table_privilege(current_user, 'audit_prune_receipts', 'SELECT') AS allowed",
    );
    expect(receiptSelect.records[0]?.allowed).toBe(true);
  });

  it("should reject the startup assertion when the app connection is over-privileged", async () => {
    await expect(
      assertControlPlaneSeparation({ appDatabase: testDb.db, authDatabase: authDb }),
    ).rejects.toBeInstanceOf(AuthPrivilegeError);
  });

  it("should accept the startup assertion with the real restricted connections", async () => {
    await expect(
      assertControlPlaneSeparation({ appDatabase: appDb, authDatabase: authDb }),
    ).resolves.toBeUndefined();
  });

  it("should keep local login and credential updates working on the auth role", async () => {
    const password = "Auth-Role-Password-1";
    const hash = await hashPassword(password);
    const principalId = testUlid(970);
    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, email, status)
       VALUES (:id, 'user', 'Auth Role User', :email, 'active')`,
      { id: principalId, email: `${principalId.toLowerCase()}@example.test` },
    );
    await testDb.db.executeQuery(
      `INSERT INTO local_credentials (principal_id, password_hash, must_change)
       VALUES (:id, :hash, false)`,
      { id: principalId, hash },
    );

    const credentials = new CredentialsRepository(authDb);
    const login = await new LocalLoginService({ credentials }).login({
      identifier: `${principalId.toLowerCase()}@example.test`,
      password,
    });
    expect(login.ok).toBe(true);
    const replacement = await hashPassword("Auth-Role-Password-2");
    await expect(credentials.changePassword(principalId, replacement, hash)).resolves.toBe(true);
  });

  it("should keep CLI family creation on the auth role", async () => {
    const password = "Auth-Cli-Password-1";
    const hash = await hashPassword(password);
    const principalId = testUlid(971);
    await testDb.db.executeQuery(
      `INSERT INTO principals (id, kind, name, email, status)
       VALUES (:id, 'user', 'Auth CLI User', :email, 'active')`,
      { id: principalId, email: `${principalId.toLowerCase()}@example.test` },
    );
    await testDb.db.executeQuery(
      `INSERT INTO local_credentials (principal_id, password_hash, must_change)
       VALUES (:id, :hash, false)`,
      { id: principalId, hash },
    );

    const family = await new CliSessionRepository(authDb).createFamilyForLogin(principalId, hash, {
      ip: null,
      userAgent: null,
    });
    expect(family.kind).toBe("created");
  });

  it("should keep assignment and OIDC identity writes on the auth role", async () => {
    await expect(
      new PolicyRepository(authDb).insertAssignment(authDb, {
        id: testUlid(972),
        principalId: actors.projectAuditor,
        role: "reader",
        scopeType: "org",
        scopeId: "org",
        grantedBy: actors.orgAdmin,
        expiresAt: null,
        principalKind: "user",
      }),
    ).resolves.toMatchObject({ role: "reader" });

    await expect(
      authDb.executeQuery(
        `INSERT INTO oidc_identities (principal_id, issuer, subject)
         VALUES (:principalId, :issuer, :subject)`,
        {
          principalId: actors.projectAuditor,
          issuer: "https://idp.example.test",
          subject: `subject-${testUlid(973)}`,
        },
      ),
    ).resolves.toBeDefined();
  });

  it("should keep data-plane writes on the app role", async () => {
    await expect(
      appDb.executeQuery("UPDATE secrets SET updated_at = now() WHERE id = :id", {
        id: base.secretId,
      }),
    ).resolves.toBeDefined();
  });
});
