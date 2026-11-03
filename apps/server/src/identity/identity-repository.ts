/** Minimal query surface shared by repositories and transactions. */
export interface QueryExecutor {
  /** Executes a named-parameter query. */
  executeQuery<T>(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<{ readonly records: readonly T[] }>;
}

/** A project row used for target and scope checks. */
export interface ProjectRecord {
  /** Project identifier. */
  readonly id: string;
  /** Project display name. */
  readonly name: string;
  /** Soft-delete timestamp, or null. */
  readonly deletedAt: Date | null;
}

/** A service identity projected for the admin API. */
export interface IdentityRecord {
  /** Principal identifier. */
  readonly id: string;
  /** Service name. */
  readonly name: string;
  /** Owner project identifier. */
  readonly projectId: string;
  /** Active or disabled status. */
  readonly status: "active" | "disabled";
  /** Creation time. */
  readonly createdAt: Date;
  /** Owner project soft-delete timestamp. */
  readonly projectDeletedAt: Date | null;
}

/** A retained workload certificate. */
export interface IdentityCertificateRecord {
  /** Certificate serial. */
  readonly serial: string;
  /** SHA-256 DER fingerprint. */
  readonly fingerprint: string;
  /** Validity start. */
  readonly notBefore: Date;
  /** Validity end. */
  readonly notAfter: Date;
  /** Revocation time, or null. */
  readonly revokedAt: Date | null;
}

/** Last reported consumer metadata. */
export interface IdentityConsumerRecord {
  /** Compose project name. */
  readonly composeProject: string;
  /** Compose service name. */
  readonly composeService: string;
  /** Reported hostname. */
  readonly hostname: string;
  /** Manifest hash. */
  readonly manifestHash: string;
  /** Consumer state. */
  readonly state: "ok" | "degraded" | "failed";
  /** First observation. */
  readonly firstSeen: Date;
  /** Last observation. */
  readonly lastSeen: Date;
}

/** Allowed list scope: every project or an explicit project set. */
export type IdentityScope = "all" | readonly string[];

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly deleted_at: Date | null;
}

interface IdentityRow {
  readonly id: string;
  readonly name: string;
  readonly owner_project_id: string;
  readonly status: string;
  readonly created_at: Date;
  readonly project_deleted_at: Date | null;
}

interface CertificateRow {
  readonly serial: string;
  readonly fingerprint: string;
  readonly not_before: Date;
  readonly not_after: Date;
  readonly revoked_at: Date | null;
}

interface ConsumerRow {
  readonly compose_project: string;
  readonly compose_service: string;
  readonly hostname: string;
  readonly manifest_hash: string;
  readonly state: string;
  readonly first_seen: Date;
  readonly last_seen: Date;
}

interface LockedIdentityRow {
  readonly owner_project_id: string;
  readonly status: string;
}

function toIdentity(row: IdentityRow): IdentityRecord {
  return {
    id: row.id,
    name: row.name,
    projectId: row.owner_project_id,
    status: row.status === "active" ? "active" : "disabled",
    createdAt: row.created_at,
    projectDeletedAt: row.project_deleted_at,
  };
}

function toCertificate(row: CertificateRow): IdentityCertificateRecord {
  return {
    serial: row.serial,
    fingerprint: row.fingerprint,
    notBefore: row.not_before,
    notAfter: row.not_after,
    revokedAt: row.revoked_at,
  };
}

function toConsumer(row: ConsumerRow): IdentityConsumerRecord {
  return {
    composeProject: row.compose_project,
    composeService: row.compose_service,
    hostname: row.hostname,
    manifestHash: row.manifest_hash,
    state: row.state === "ok" || row.state === "degraded" ? row.state : "failed",
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}

/**
 * Reads and mutates service identities in PostgreSQL.
 *
 * The repository keeps SQL and transaction-scoped updates together. Callers
 * provide the transaction for multi-table revocation so the principal,
 * certificates, tokens, and consumer row move atomically.
 */
export class IdentityRepository {
  readonly #database: QueryExecutor;

  /**
   * @param database - Connected database or transaction executor.
   */
  public constructor(database: QueryExecutor) {
    this.#database = database;
  }

  /**
   * Loads a project, including a soft-deleted target.
   *
   * @param id - Project identifier.
   * @returns The project row, or undefined.
   */
  public async findProject(id: string): Promise<ProjectRecord | undefined> {
    const result = await this.#database.executeQuery<ProjectRow>(
      "SELECT id, name, deleted_at FROM projects WHERE id = :id",
      { id },
    );
    const row = result.records[0];
    return row === undefined
      ? undefined
      : { id: row.id, name: row.name, deletedAt: row.deleted_at };
  }

  /**
   * Locks a project and returns its deletion state.
   *
   * Callers use this before creating an identity or issuing a token so a
   * concurrent soft-delete serializes with the write.
   *
   * @param tx - Transaction executor.
   * @param id - Project identifier.
   * @returns The locked project, or undefined.
   */
  public async lockProject(tx: QueryExecutor, id: string): Promise<ProjectRecord | undefined> {
    const result = await tx.executeQuery<ProjectRow>(
      "SELECT id, name, deleted_at FROM projects WHERE id = :id FOR SHARE",
      { id },
    );
    const row = result.records[0];
    return row === undefined
      ? undefined
      : { id: row.id, name: row.name, deletedAt: row.deleted_at };
  }

  /**
   * Loads one service identity and its owner-project deletion state.
   *
   * @param id - Principal identifier.
   * @returns The identity, or undefined.
   */
  public async findIdentity(id: string): Promise<IdentityRecord | undefined> {
    const result = await this.#database.executeQuery<IdentityRow>(
      `SELECT p.id, p.name, p.owner_project_id, p.status, p.created_at,
              pr.deleted_at AS project_deleted_at
         FROM principals p
         JOIN projects pr ON pr.id = p.owner_project_id
        WHERE p.id = :id AND p.kind = 'service'`,
      { id },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toIdentity(row);
  }

  /**
   * Inserts a service principal and returns its public summary fields.
   *
   * @param input - Identifier, trimmed name, and owner project.
   * @returns The inserted identity.
   */
  public async insertServiceIdentity(
    input: {
      readonly id: string;
      readonly name: string;
      readonly projectId: string;
    },
    executor: QueryExecutor = this.#database,
  ): Promise<IdentityRecord> {
    const result = await executor.executeQuery<IdentityRow>(
      `INSERT INTO principals (id, kind, name, owner_project_id, status)
       VALUES (:id, 'service', :name, :projectId, 'active')
       RETURNING id, name, owner_project_id, status, created_at,
                 NULL::timestamptz AS project_deleted_at`,
      input,
    );
    const row = result.records[0];
    if (row === undefined) {
      throw new Error("service identity insert did not return a row");
    }
    return toIdentity(row);
  }

  /**
   * Lists service identities in the resolved scope.
   *
   * @param scope - All projects or an explicit project set.
   * @param projectId - Optional exact project filter.
   * @returns Matching identities ordered by creation time.
   */
  public async listIdentities(
    scope: IdentityScope,
    projectId?: string,
  ): Promise<readonly IdentityRecord[]> {
    if (scope !== "all" && scope.length === 0) {
      return [];
    }

    const conditions = ["p.kind = 'service'", "pr.deleted_at IS NULL"];
    const params: Record<string, unknown> = {};
    if (projectId !== undefined) {
      conditions.push("p.owner_project_id = :projectId");
      params.projectId = projectId;
    } else if (scope !== "all") {
      conditions.push("p.owner_project_id = ANY(:projectIds)");
      params.projectIds = scope;
    }

    const result = await this.#database.executeQuery<IdentityRow>(
      `SELECT p.id, p.name, p.owner_project_id, p.status, p.created_at,
              pr.deleted_at AS project_deleted_at
         FROM principals p
         JOIN projects pr ON pr.id = p.owner_project_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY p.created_at DESC, p.id DESC`,
      params,
    );
    return result.records.map(toIdentity);
  }

  /**
   * Lists every retained certificate for an identity, newest first.
   *
   * @param principalId - Service principal identifier.
   * @returns Certificate history.
   */
  public async listCertificates(
    principalId: string,
  ): Promise<readonly IdentityCertificateRecord[]> {
    const result = await this.#database.executeQuery<CertificateRow>(
      `SELECT serial, fingerprint, not_before, not_after, revoked_at
         FROM workload_certs
        WHERE principal_id = :principalId
        ORDER BY issued_at DESC, id DESC`,
      { principalId },
    );
    return result.records.map(toCertificate);
  }

  /**
   * Loads the consumer row for an identity.
   *
   * @param principalId - Service principal identifier.
   * @returns Consumer metadata, or undefined.
   */
  public async findConsumer(principalId: string): Promise<IdentityConsumerRecord | undefined> {
    const result = await this.#database.executeQuery<ConsumerRow>(
      `SELECT compose_project, compose_service, hostname, manifest_hash, state,
              first_seen, last_seen
         FROM consumers
        WHERE principal_id = :principalId`,
      { principalId },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toConsumer(row);
  }

  /**
   * Locks a service principal for revocation or token issuance.
   *
   * @param tx - Transaction executor.
   * @param id - Principal identifier.
   * @returns Owner project and status, or undefined.
   */
  public async lockIdentity(
    tx: QueryExecutor,
    id: string,
  ): Promise<{ readonly projectId: string; readonly status: "active" | "disabled" } | undefined> {
    const result = await tx.executeQuery<LockedIdentityRow>(
      `SELECT owner_project_id, status
         FROM principals
        WHERE id = :id AND kind = 'service'
        FOR UPDATE`,
      { id },
    );
    const row = result.records[0];
    return row === undefined
      ? undefined
      : {
          projectId: row.owner_project_id,
          status: row.status === "active" ? "active" : "disabled",
        };
  }

  /**
   * Marks an identity, its unexpired certificates, and its consumer as revoked.
   *
   * Token rows are owned by the join-token service and updated by its
   * transaction method.
   *
   * @param tx - Transaction executor.
   * @param principalId - Service principal identifier.
   */
  public async revokeIdentity(tx: QueryExecutor, principalId: string): Promise<void> {
    await tx.executeQuery(
      `UPDATE principals
          SET status = 'disabled', disabled_at = COALESCE(disabled_at, now())
        WHERE id = :principalId`,
      { principalId },
    );
    await tx.executeQuery(
      `UPDATE workload_certs
          SET revoked_at = now()
        WHERE principal_id = :principalId
          AND revoked_at IS NULL
          AND not_after > now()`,
      { principalId },
    );
    await tx.executeQuery(
      `UPDATE consumers
          SET state = 'failed', last_seen = now()
        WHERE principal_id = :principalId`,
      { principalId },
    );
  }
}
