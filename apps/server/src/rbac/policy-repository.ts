import { RBAC_ROLES, type RbacRole, type RbacScopeType } from "@openvault/api-contract";
import type { QueryExecutor } from "../identity/identity-repository.js";
import { PolicyUnavailableError } from "./errors.js";

const ROLE_SET: ReadonlySet<string> = new Set(RBAC_ROLES);
const SCOPE_SET: ReadonlySet<string> = new Set(["org", "project", "object"]);

/** One assignment loaded into an actor snapshot. */
export interface ActorAssignment {
  /** Assignment row identifier. */
  readonly id: string;
  /** Fixed role. */
  readonly role: RbacRole;
  /** Assignment scope type. */
  readonly scopeType: RbacScopeType;
  /** Assignment scope identifier. */
  readonly scopeId: string;
  /** Expiry, or null for no expiry. */
  readonly expiresAt: Date | null;
}

/** The live policy state for one actor. */
export interface ActorSnapshot {
  /** Principal identifier. */
  readonly principalId: string;
  /** Principal kind. */
  readonly kind: "user" | "service";
  /** Principal status. */
  readonly status: "active" | "disabled";
  /** Current policy version. */
  readonly policyVersion: number;
  /** Every assignment, including expired rows. */
  readonly assignments: readonly ActorAssignment[];
}

interface VersionRow {
  readonly version: string | number;
}

interface ActorRow {
  readonly principal_id: string;
  readonly kind: string;
  readonly status: string;
  readonly policy_version: string | number | null;
  readonly assignment_id: string | null;
  readonly role: string | null;
  readonly scope_type: string | null;
  readonly scope_id: string | null;
  readonly expires_at: Date | null;
}

/** Returns true for a known role name. */
function isRole(value: string): value is RbacRole {
  return ROLE_SET.has(value);
}

/** Returns true for a known scope type. */
function isScopeType(value: string): value is RbacScopeType {
  return SCOPE_SET.has(value);
}

/** Returns true for a known principal kind. */
function isPrincipalKind(value: string): value is "user" | "service" {
  return value === "user" || value === "service";
}

/**
 * Persistence boundary for policy state.
 *
 * The repository returns one statement snapshot of the principal, version, and
 * assignments. It never caches between calls.
 */
export class PolicyRepository {
  readonly #database: QueryExecutor;

  /**
   * @param database - Database or transaction executor.
   */
  public constructor(database: QueryExecutor) {
    this.#database = database;
  }

  /**
   * Reads the current policy version.
   *
   * @returns Positive integer version.
   * @throws {PolicyUnavailableError} When the row is missing or unreadable.
   */
  public async readPolicyVersion(): Promise<number> {
    let result: { readonly records: readonly VersionRow[] };
    try {
      result = await this.#database.executeQuery<VersionRow>(
        "SELECT version FROM policy_state WHERE id = 1",
      );
    } catch {
      throw new PolicyUnavailableError();
    }
    const row = result.records[0];
    if (row === undefined) {
      throw new PolicyUnavailableError();
    }
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new PolicyUnavailableError();
    }
    return version;
  }

  /**
   * Locks the policy row and increments its version.
   *
   * This must be the first statement in an assignment mutation transaction.
   * The update both serializes writers and records the policy change.
   *
   * @param database - Transaction executor.
   * @returns The new version.
   * @throws {PolicyUnavailableError} When the row is missing.
   */
  public async bumpPolicyVersion(database: QueryExecutor): Promise<number> {
    let result: { readonly records: readonly VersionRow[] };
    try {
      result = await database.executeQuery<VersionRow>(
        `UPDATE policy_state
            SET version = version + 1, updated_at = now()
          WHERE id = 1
          RETURNING version`,
      );
    } catch {
      throw new PolicyUnavailableError();
    }
    const row = result.records[0];
    if (row === undefined) {
      throw new PolicyUnavailableError();
    }
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new PolicyUnavailableError();
    }
    return version;
  }

  /**
   * Loads one actor's principal state, version, and assignments.
   *
   * @param actorId - Principal identifier.
   * @returns The snapshot, or undefined when the principal does not exist.
   * @throws {PolicyUnavailableError} When the version row or query is unavailable.
   */
  public async loadActorSnapshot(actorId: string): Promise<ActorSnapshot | undefined> {
    let result: { readonly records: readonly ActorRow[] };
    try {
      result = await this.#database.executeQuery<ActorRow>(
        `SELECT p.id AS principal_id, p.kind, p.status,
                (SELECT version FROM policy_state WHERE id = 1) AS policy_version,
                r.id AS assignment_id, r.role, r.scope_type, r.scope_id, r.expires_at
           FROM principals p
           LEFT JOIN role_assignments r ON r.principal_id = p.id
          WHERE p.id = :actorId`,
        { actorId },
      );
    } catch {
      throw new PolicyUnavailableError();
    }
    const first = result.records[0];
    if (first === undefined) {
      return undefined;
    }
    if (first.policy_version === null) {
      throw new PolicyUnavailableError();
    }
    const policyVersion = Number(first.policy_version);
    if (!Number.isSafeInteger(policyVersion) || policyVersion <= 0) {
      throw new PolicyUnavailableError();
    }
    if (!isPrincipalKind(first.kind)) {
      throw new PolicyUnavailableError();
    }

    const assignments: ActorAssignment[] = [];
    for (const row of result.records) {
      if (
        row.assignment_id === null ||
        row.role === null ||
        row.scope_type === null ||
        row.scope_id === null ||
        !isRole(row.role) ||
        !isScopeType(row.scope_type)
      ) {
        continue;
      }
      assignments.push({
        id: row.assignment_id,
        role: row.role,
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        expiresAt: row.expires_at,
      });
    }

    return {
      principalId: first.principal_id,
      kind: first.kind,
      status: first.status === "active" ? "active" : "disabled",
      policyVersion,
      assignments,
    };
  }
}
