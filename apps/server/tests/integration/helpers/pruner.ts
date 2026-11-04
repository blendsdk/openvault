import { Client } from "pg";

const PRUNER_USER = "openvault_pruner";
const PRUNER_PASSWORD = "test-password";

/**
 * Provisions the dedicated pruner role for one disposable database.
 *
 * The role gets `SELECT, DELETE` because PostgreSQL evaluates the delete
 * predicate against the `id` column. Returns undefined when the maintenance
 * user is not a superuser.
 *
 * @param maintenanceUrl - Maintenance connection for role creation.
 * @param testDatabase - Disposable database name.
 * @returns A prune URL for the test database, or undefined.
 */
export async function ensurePrunerRole(
  maintenanceUrl: string,
  testDatabase: string,
): Promise<string | undefined> {
  if (!maintenanceUrl.startsWith("postgres://") && !maintenanceUrl.startsWith("postgresql://")) {
    throw new Error("A local test database URL is required");
  }
  if (!testDatabase.startsWith("openvault_test_")) {
    throw new Error("The pruner helper only accepts a disposable test database");
  }
  const admin = new Client({ connectionString: maintenanceUrl });
  await admin.connect();
  try {
    const role = await admin.query<{ rolsuper: boolean }>(
      `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`,
    );
    if (role.rows[0]?.rolsuper !== true) {
      return undefined;
    }
    const existing = await admin.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PRUNER_USER}') AS present`,
    );
    if (existing.rows[0]?.present !== true) {
      await admin.query(`CREATE ROLE ${PRUNER_USER} LOGIN PASSWORD '${PRUNER_PASSWORD}'`);
    }
  } finally {
    await admin.end();
  }

  const testUrl = new URL(maintenanceUrl);
  testUrl.pathname = `/${testDatabase}`;
  const grant = new Client({ connectionString: testUrl.toString() });
  await grant.connect();
  try {
    await grant.query(`GRANT SELECT, DELETE ON audit_events TO ${PRUNER_USER}`);
  } finally {
    await grant.end();
  }

  testUrl.username = PRUNER_USER;
  testUrl.password = PRUNER_PASSWORD;
  return testUrl.toString();
}
