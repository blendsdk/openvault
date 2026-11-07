/** Minimal query surface used by the startup privilege check. */
export interface PrivilegeDatabase {
  executeQuery<T>(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<{ readonly records: readonly T[] }>;
}

/** Raised when a runtime connection has the wrong control-plane privileges. */
export class AuthPrivilegeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AuthPrivilegeError";
  }
}

/** Tables that only the control-plane role may write. */
export const CONTROL_PLANE_TABLES = [
  "principals",
  "local_credentials",
  "role_assignments",
  "oidc_identities",
  "cli_sessions",
  "join_tokens",
  "workload_certs",
  "consumers",
] as const;

const WRITE_VERBS = ["INSERT", "UPDATE", "DELETE"] as const;

/**
 * Reads one `has_table_privilege` answer for the connected role.
 *
 * @param database - Connection to inspect.
 * @param table - Table name from the fixed control-plane list.
 * @param verb - SQL verb to test.
 * @returns True when the connected role has the privilege.
 */
async function hasTablePrivilege(
  database: PrivilegeDatabase,
  table: string,
  verb: string,
): Promise<boolean> {
  const result = await database.executeQuery<{ allowed: boolean }>(
    "SELECT has_table_privilege(current_user, :table, :verb) AS allowed",
    { table, verb },
  );
  return result.records[0]?.allowed === true;
}

/**
 * Fails closed when the app role can write control-plane tables or the auth
 * role is over-privileged.
 *
 * The check runs only in production. Development and tests use a shared
 * superuser connection and do not model the deployed grants.
 *
 * @param options - App and auth connections.
 * @throws {AuthPrivilegeError} When the grant contract is not met.
 */
export async function assertControlPlaneSeparation(options: {
  readonly appDatabase: PrivilegeDatabase;
  readonly authDatabase: PrivilegeDatabase;
}): Promise<void> {
  for (const table of CONTROL_PLANE_TABLES) {
    for (const verb of WRITE_VERBS) {
      if (await hasTablePrivilege(options.appDatabase, table, verb)) {
        throw new AuthPrivilegeError(
          `control-plane privilege mismatch: openvault_app still has ${verb} on ${table}`,
        );
      }
      if (!(await hasTablePrivilege(options.authDatabase, table, verb))) {
        throw new AuthPrivilegeError(
          `control-plane privilege mismatch: openvault_auth lacks ${verb} on ${table}`,
        );
      }
    }
  }
  for (const verb of WRITE_VERBS) {
    if (await hasTablePrivilege(options.appDatabase, "policy_state", verb)) {
      throw new AuthPrivilegeError(
        `control-plane privilege mismatch: openvault_app still has ${verb} on policy_state`,
      );
    }
  }
  if (await hasTablePrivilege(options.appDatabase, "projects", "DELETE")) {
    throw new AuthPrivilegeError(
      "control-plane privilege mismatch: openvault_app still has DELETE on projects",
    );
  }
  for (const table of [...CONTROL_PLANE_TABLES, "policy_state", "org", "blendsdk_migrations"]) {
    if (await hasTablePrivilege(options.appDatabase, table, "SELECT")) {
      throw new AuthPrivilegeError(
        `control-plane privilege mismatch: openvault_app still has SELECT on ${table}`,
      );
    }
  }

  const appRole = await options.appDatabase.executeQuery<{
    readonly rolsuper: boolean;
    readonly rolcreaterole: boolean;
    readonly rolcreatedb: boolean;
    readonly rolbypassrls: boolean;
    readonly rolreplication: boolean;
    readonly is_auth: boolean;
    readonly is_backup: boolean;
    readonly is_purger: boolean;
    readonly is_pruner: boolean;
    readonly is_migrator: boolean;
  }>(
    `SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication,
            COALESCE(pg_has_role(current_user, to_regrole('openvault_auth'), 'MEMBER'), false)
              AS is_auth,
            COALESCE(pg_has_role(current_user, to_regrole('openvault_backup'), 'MEMBER'), false)
              AS is_backup,
            COALESCE(pg_has_role(current_user, to_regrole('openvault_purger'), 'MEMBER'), false)
              AS is_purger,
            COALESCE(pg_has_role(current_user, to_regrole('openvault_pruner'), 'MEMBER'), false)
              AS is_pruner,
            COALESCE(pg_has_role(current_user, to_regrole('openvault_migrator'), 'MEMBER'), false)
              AS is_migrator
       FROM pg_roles r
      WHERE r.rolname = current_user`,
  );
  const appRoleRow = appRole.records[0];
  if (
    appRoleRow === undefined ||
    appRoleRow.rolsuper ||
    appRoleRow.rolcreaterole ||
    appRoleRow.rolcreatedb ||
    appRoleRow.rolbypassrls ||
    appRoleRow.rolreplication ||
    appRoleRow.is_auth ||
    appRoleRow.is_backup ||
    appRoleRow.is_purger ||
    appRoleRow.is_pruner ||
    appRoleRow.is_migrator
  ) {
    throw new AuthPrivilegeError(
      "control-plane privilege mismatch: openvault_app has excessive role attributes or memberships",
    );
  }

  const role = await options.authDatabase.executeQuery<{
    readonly rolsuper: boolean;
    readonly rolcreaterole: boolean;
    readonly rolcreatedb: boolean;
    readonly rolbypassrls: boolean;
    readonly is_migrator: boolean;
    readonly is_app: boolean;
    readonly is_backup: boolean;
    readonly is_purger: boolean;
    readonly is_pruner: boolean;
  }>(
    `SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls,
            COALESCE(pg_has_role(current_user, to_regrole('openvault_migrator'), 'MEMBER'), false)
              AS is_migrator,
            COALESCE(pg_has_role(current_user, to_regrole('openvault_app'), 'MEMBER'), false)
              AS is_app,
            COALESCE(pg_has_role(current_user, to_regrole('openvault_backup'), 'MEMBER'), false)
              AS is_backup,
            COALESCE(pg_has_role(current_user, to_regrole('openvault_purger'), 'MEMBER'), false)
              AS is_purger,
            COALESCE(pg_has_role(current_user, to_regrole('openvault_pruner'), 'MEMBER'), false)
              AS is_pruner
       FROM pg_roles r
      WHERE r.rolname = current_user`,
  );
  const roleRow = role.records[0];
  if (
    roleRow === undefined ||
    roleRow.rolsuper ||
    roleRow.rolcreaterole ||
    roleRow.rolcreatedb ||
    roleRow.rolbypassrls ||
    roleRow.is_migrator ||
    roleRow.is_app ||
    roleRow.is_backup ||
    roleRow.is_purger ||
    roleRow.is_pruner
  ) {
    throw new AuthPrivilegeError(
      "control-plane privilege mismatch: openvault_auth has excessive role attributes or memberships",
    );
  }
  const schemaCreate = await options.authDatabase.executeQuery<{ readonly allowed: boolean }>(
    "SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS allowed",
  );
  if (schemaCreate.records[0]?.allowed === true) {
    throw new AuthPrivilegeError(
      "control-plane privilege mismatch: openvault_auth can create objects in public",
    );
  }

  for (const table of CONTROL_PLANE_TABLES) {
    const owner = await options.authDatabase.executeQuery<{ readonly owns: boolean }>(
      `SELECT tableowner = current_user AS owns
         FROM pg_tables
        WHERE schemaname = 'public' AND tablename = :table`,
      { table },
    );
    if (owner.records[0]?.owns === true) {
      throw new AuthPrivilegeError(
        `control-plane privilege mismatch: openvault_auth owns ${table}`,
      );
    }
  }

  const required = [
    ["projects", "SELECT"],
    ["projects", "UPDATE"],
    ["secrets", "SELECT"],
    ["certificates", "SELECT"],
    ["policy_state", "SELECT"],
    ["policy_state", "UPDATE"],
    ["audit_events", "SELECT"],
    ["audit_events", "INSERT"],
    ["audit_checkpoints", "SELECT"],
    ["audit_checkpoints", "INSERT"],
    ["audit_keys", "SELECT"],
    ["audit_keys", "INSERT"],
  ] as const;
  for (const [table, verb] of required) {
    if (!(await hasTablePrivilege(options.authDatabase, table, verb))) {
      throw new AuthPrivilegeError(
        `control-plane privilege mismatch: openvault_auth lacks ${verb} on ${table}`,
      );
    }
  }
}
