import { Client } from "pg";

const PURGER_USER = "openvault_purger";
const PURGER_PASSWORD = "test-password";

/**
 * Provisions the dedicated purge role for one disposable database.
 *
 * The role needs `SELECT` on `projects` for the active-project lock and
 * `SELECT, DELETE` on `secrets` and `secret_versions` for the guarded delete.
 * Returns undefined when the maintenance user is not a superuser.
 *
 * @param maintenanceUrl - Maintenance connection for role creation.
 * @param testDatabase - Disposable database name.
 * @returns A purge URL for the test database, or undefined.
 */
export async function ensurePurgerRole(
  maintenanceUrl: string,
  testDatabase: string,
): Promise<string | undefined> {
  if (!maintenanceUrl.startsWith("postgres://") && !maintenanceUrl.startsWith("postgresql://")) {
    throw new Error("A local test database URL is required");
  }
  if (!testDatabase.startsWith("openvault_test_")) {
    throw new Error("The purger helper only accepts a disposable test database");
  }
  const admin = new Client({ connectionString: maintenanceUrl });
  await admin.connect();
  try {
    const role = await admin.query<{ rolsuper: boolean }>(
      "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    if (role.rows[0]?.rolsuper !== true) {
      return undefined;
    }
    const existing = await admin.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PURGER_USER}') AS present`,
    );
    if (existing.rows[0]?.present !== true) {
      await admin.query(`CREATE ROLE ${PURGER_USER} LOGIN PASSWORD '${PURGER_PASSWORD}'`);
    }
  } finally {
    await admin.end();
  }

  const testUrl = new URL(maintenanceUrl);
  testUrl.pathname = `/${testDatabase}`;
  const grant = new Client({ connectionString: testUrl.toString() });
  await grant.connect();
  try {
    await grant.query(`GRANT SELECT ON projects TO ${PURGER_USER}`);
    await grant.query(`GRANT SELECT, DELETE ON secrets TO ${PURGER_USER}`);
    await grant.query(`GRANT SELECT, DELETE ON secret_versions TO ${PURGER_USER}`);
    const check = await grant.query<{ project: boolean; secrets: boolean; versions: boolean }>(
      `SELECT has_table_privilege('${PURGER_USER}', 'projects', 'SELECT') AS project,
              has_table_privilege('${PURGER_USER}', 'secrets', 'SELECT, DELETE') AS secrets,
              has_table_privilege('${PURGER_USER}', 'secret_versions', 'SELECT, DELETE') AS versions`,
    );
    if (!check.rows[0]?.project || !check.rows[0]?.secrets || !check.rows[0]?.versions) {
      throw new Error(`Purger grants are incomplete: ${JSON.stringify(check.rows[0])}`);
    }
  } finally {
    await grant.end();
  }

  testUrl.username = PURGER_USER;
  testUrl.password = PURGER_PASSWORD;
  return testUrl.toString();
}
