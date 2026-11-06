import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { newUlid } from "@openvault/core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  resolveTestDatabaseSettings,
  type TestDatabase,
} from "./helpers/test-database.js";

const rolesSql = readFileSync(
  fileURLToPath(new URL("../../../../deploy/postgres/roles.sql", import.meta.url)),
  "utf8",
);
const grantsSql = readFileSync(
  fileURLToPath(new URL("../../../../deploy/postgres/grants.sql", import.meta.url)),
  "utf8",
);

const PASSWORDS = {
  migrator: "migrator-password",
  app: "app-password",
  purger: "purger-password",
  pruner: "pruner-password",
} as const;

interface Settings {
  readonly maintenanceUrl: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

let settings: Settings;
let databaseName: string;
let admin: Client;
let app: Client;
let purger: Client;
let pruner: Client;
let purgerPassword: string = PASSWORDS.purger;

/** Quotes one SQL literal. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Quotes one PostgreSQL identifier. */
function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Executes the small psql subset used by the deployment SQL files.
 *
 * The files use `:'name'`, `:"name"`, and `\gexec`. Supporting those three forms
 * lets the test exercise the real deployment SQL without requiring a `psql`
 * binary in the test image.
 */
async function applyPsqlScript(
  client: Client,
  sql: string,
  variables: Readonly<Record<string, string>>,
): Promise<void> {
  const interpolate = (value: string): string =>
    value
      .replace(/:'([A-Za-z_][A-Za-z0-9_]*)'/g, (_match, name: string) =>
        literal(variables[name] ?? ""),
      )
      .replace(/:"([A-Za-z_][A-Za-z0-9_]*)"/g, (_match, name: string) =>
        identifier(variables[name] ?? ""),
      );
  const lines = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("\\set"))
    .join("\n");
  const parts = lines.split("\\gexec");
  for (const [index, part] of parts.entries()) {
    const statement = interpolate(part).trim();
    if (statement.length === 0) {
      continue;
    }
    const result = await client.query(statement);
    if (index < parts.length - 1) {
      for (const row of result.rows as Array<Record<string, unknown>>) {
        const generated = Object.values(row)[0];
        if (typeof generated !== "string") {
          throw new Error("\\gexec did not return a statement");
        }
        await client.query(generated);
      }
    }
  }
}

/** Builds a role URL. */
function roleUrl(role: string, password: string): string {
  return `postgres://${role}:${password}@${settings.host}:${settings.port}/${databaseName}`;
}

beforeAll(async () => {
  settings = resolveTestDatabaseSettings();
  const suffix = randomBytes(4).toString("hex");
  databaseName = `openvault_roles_${suffix}_test`;
  admin = new Client({ connectionString: settings.maintenanceUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${identifier(databaseName)}`);

  // The certificate integration suite creates the shared purge role with its
  // own test password. Reuse that password instead of breaking the suite.
  const existingPurger = await admin.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openvault_purger') AS present",
  );
  if (existingPurger.rows[0]?.present === true) {
    purgerPassword = "test-password";
  }

  const owner = new Client({
    connectionString: `postgres://${settings.user}:${encodeURIComponent(settings.password)}@${settings.host}:${settings.port}/${databaseName}`,
  });
  await owner.connect();
  try {
    await applyPsqlScript(owner, rolesSql, {
      dbname: databaseName,
      migrator_password: PASSWORDS.migrator,
      app_password: PASSWORDS.app,
      purger_password: purgerPassword,
      pruner_password: PASSWORDS.pruner,
    });
  } finally {
    await owner.end();
  }

  await applyMigrations({ url: roleUrl("openvault_migrator", PASSWORDS.migrator) } as TestDatabase);

  const migrator = new Client({
    connectionString: roleUrl("openvault_migrator", PASSWORDS.migrator),
  });
  await migrator.connect();
  try {
    await applyPsqlScript(migrator, grantsSql, {});
  } finally {
    await migrator.end();
  }

  app = new Client({ connectionString: roleUrl("openvault_app", PASSWORDS.app) });
  purger = new Client({ connectionString: roleUrl("openvault_purger", purgerPassword) });
  pruner = new Client({ connectionString: roleUrl("openvault_pruner", PASSWORDS.pruner) });
  await Promise.all([app.connect(), purger.connect(), pruner.connect()]);
}, 60_000);

afterAll(async () => {
  await Promise.all([app?.end(), purger?.end(), pruner?.end()]);
  if (admin !== undefined) {
    const cleanup = new Client({
      connectionString: `postgres://${settings.user}:${encodeURIComponent(settings.password)}@${settings.host}:${settings.port}/${databaseName}`,
    });
    try {
      await cleanup.connect();
      await cleanup.query(
        "DROP OWNED BY openvault_app, openvault_purger, openvault_pruner, openvault_migrator CASCADE",
      );
    } catch {
      // The database may already be gone after a failed setup.
    } finally {
      await cleanup.end().catch(() => undefined);
    }
    await admin.query(`DROP DATABASE IF EXISTS ${identifier(databaseName)} WITH (FORCE)`);
    // Leave the shared purge role for the certificate suite. The other roles
    // belong to this test; a stale dependency must not fail an otherwise green
    // run, so cleanup is best effort.
    for (const role of ["openvault_app", "openvault_pruner", "openvault_migrator"]) {
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
    await admin.end();
  }
});

describe("least-privilege PostgreSQL roles", () => {
  it("lets the runtime role read and write data but not run DDL or delete audit events", async () => {
    const org = await app.query<{ count: string }>("SELECT count(*)::text AS count FROM org");
    expect(Number(org.rows[0]?.count)).toBeGreaterThanOrEqual(1);

    const projectId = newUlid();
    await app.query("BEGIN");
    try {
      await app.query("INSERT INTO projects (id, name) VALUES ($1, 'roles-probe')", [projectId]);
    } finally {
      await app.query("ROLLBACK");
    }

    await expect(app.query("CREATE TABLE app_ddl_probe (id integer)")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(app.query("DELETE FROM audit_events")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(app.query("DELETE FROM audit_keys")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(app.query("DELETE FROM ca_keys")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(app.query("DELETE FROM signing_keys")).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("limits the purger to project names and purgeable objects", async () => {
    await expect(purger.query("DELETE FROM secrets WHERE false")).resolves.toBeDefined();
    await expect(purger.query("SELECT count(*) FROM projects")).resolves.toBeDefined();
    await expect(purger.query("SELECT count(*) FROM audit_events")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(purger.query("CREATE TABLE purger_ddl_probe (id integer)")).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("limits the pruner to the audit chain and boundary checkpoints", async () => {
    const keyId = newUlid();
    await app.query(
      `INSERT INTO audit_keys (id, wrapped_key, wrap_nonce, wrap_tag, kek_id)
       VALUES ($1, decode(repeat('00', 32), 'hex'), decode(repeat('00', 12), 'hex'),
               decode(repeat('00', 16), 'hex'), 'kek-1')`,
      [keyId],
    );

    await expect(pruner.query("SELECT count(*) FROM audit_events")).resolves.toBeDefined();
    await expect(pruner.query("DELETE FROM audit_events WHERE false")).resolves.toBeDefined();
    await expect(pruner.query("SELECT count(*) FROM secrets")).rejects.toMatchObject({
      code: "42501",
    });
    await pruner.query("BEGIN");
    try {
      await pruner.query(
        `INSERT INTO audit_checkpoints (last_event_id, last_hash, hmac, audit_key_id)
         VALUES (999999, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), $1)`,
        [keyId],
      );
    } finally {
      await pruner.query("ROLLBACK");
    }
  });

  it("keeps the migrator as the table owner and the runtime role separate", async () => {
    const owners = await app.query<{ tableowner: string }>(
      `SELECT DISTINCT tableowner FROM pg_tables
        WHERE schemaname = 'public' AND tablename NOT LIKE 'blendsdk_%'`,
    );
    expect(owners.rows.map((row) => row.tableowner)).toEqual(["openvault_migrator"]);
  });
});
