import type { QueryExecutor } from "../identity/identity-repository.js";

/** A persisted secret row. */
export interface SecretRecord {
  /** Secret identifier. */
  readonly id: string;
  /** Owning project. */
  readonly projectId: string;
  /** Secret name. */
  readonly name: string;
  /** Tags. */
  readonly tags: Readonly<Record<string, string>>;
  /** Content type. */
  readonly contentType: string;
  /** Current version pointer, or null. */
  readonly currentVersionId: string | null;
  /** Purge protection flag. */
  readonly purgeProtected: boolean;
  /** Creation time. */
  readonly createdAt: Date;
  /** Last metadata update. */
  readonly updatedAt: Date;
  /** Soft-delete time, or null. */
  readonly deletedAt: Date | null;
  /** Earliest purge time, or null. */
  readonly purgeAfter: Date | null;
}

/** A persisted immutable version. */
export interface SecretVersionRecord {
  /** Version identifier. */
  readonly id: string;
  /** Owning secret. */
  readonly secretId: string;
  /** AES-GCM ciphertext. */
  readonly ciphertext: Buffer;
  /** Value nonce. */
  readonly nonce: Buffer;
  /** Value tag. */
  readonly tag: Buffer;
  /** Wrapped data key. */
  readonly wrappedDek: Buffer;
  /** DEK-wrap nonce. */
  readonly wrapNonce: Buffer;
  /** DEK-wrap tag. */
  readonly wrapTag: Buffer;
  /** KEK identifier. */
  readonly kekId: string;
  /** Creator principal. */
  readonly createdBy: string;
  /** Creation time. */
  readonly createdAt: Date;
  /** Expiry, or null. */
  readonly expiresAt: Date | null;
}

/** Version metadata without ciphertext. */
export interface SecretVersionMetadata {
  /** Version identifier. */
  readonly id: string;
  /** Owning secret. */
  readonly secretId: string;
  /** Creator principal. */
  readonly createdBy: string;
  /** Creation time. */
  readonly createdAt: Date;
  /** Expiry, or null. */
  readonly expiresAt: Date | null;
}

/** A secret row with its current version metadata used by the list query. */
export interface SecretListRow extends SecretRecord {
  /** The current version metadata, when present. */
  readonly currentVersion: SecretVersionMetadata | null;
}

/** One consumer summary. */
export interface ConsumerSummary {
  /** Compose project name. */
  readonly composeProject: string;
  /** Compose service name. */
  readonly composeService: string;
  /** Last observation. */
  readonly lastSeen: Date;
}

/** Decoded list cursor. */
export interface ListCursor {
  /** Last name on the previous page. */
  readonly name: string;
  /** Last id on the previous page. */
  readonly id: string;
}

interface SecretRow {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly tags: Record<string, string>;
  readonly content_type: string;
  readonly current_version_id: string | null;
  readonly purge_protected: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly deleted_at: Date | null;
  readonly purge_after: Date | null;
}

interface VersionRow {
  readonly id: string;
  readonly secret_id: string;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly wrapped_dek: Buffer;
  readonly wrap_nonce: Buffer;
  readonly wrap_tag: Buffer;
  readonly kek_id: string;
  readonly created_by: string;
  readonly created_at: Date;
  readonly expires_at: Date | null;
}

interface ListRow extends SecretRow {
  readonly cv_id: string | null;
  readonly cv_created_by: string | null;
  readonly cv_created_at: Date | null;
  readonly cv_expires_at: Date | null;
}

interface VersionMetadataRow {
  readonly id: string;
  readonly secret_id: string;
  readonly created_by: string;
  readonly created_at: Date;
  readonly expires_at: Date | null;
}

const SECRET_COLUMNS = `id, project_id, name, tags, content_type, current_version_id,
  purge_protected, created_at, updated_at, deleted_at, purge_after`;
const VERSION_COLUMNS = `id, secret_id, ciphertext, nonce, tag, wrapped_dek, wrap_nonce,
  wrap_tag, kek_id, created_by, created_at, expires_at`;
const VERSION_METADATA_COLUMNS = `id, secret_id, created_by, created_at, expires_at`;

function toSecret(row: SecretRow): SecretRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    tags: row.tags,
    contentType: row.content_type,
    currentVersionId: row.current_version_id,
    purgeProtected: row.purge_protected,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after,
  };
}

function toVersion(row: VersionRow): SecretVersionRecord {
  return {
    id: row.id,
    secretId: row.secret_id,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    tag: row.tag,
    wrappedDek: row.wrapped_dek,
    wrapNonce: row.wrap_nonce,
    wrapTag: row.wrap_tag,
    kekId: row.kek_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function listRowToSecret(row: ListRow): SecretRecord {
  return toSecret(row);
}

function toVersionMetadata(row: VersionMetadataRow): SecretVersionMetadata {
  return {
    id: row.id,
    secretId: row.secret_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function listRowToVersion(row: ListRow): SecretVersionMetadata | null {
  if (row.cv_id === null || row.cv_created_at === null) {
    return null;
  }
  return {
    id: row.cv_id,
    secretId: row.id,
    createdBy: row.cv_created_by ?? "",
    createdAt: row.cv_created_at,
    expiresAt: row.cv_expires_at,
  };
}

/**
 * Reads and mutates secrets, versions, consumers, and idempotency claims.
 *
 * Every mutation takes an explicit transaction so the version insert, current
 * pointer, and joined audit decision commit together.
 */
export class SecretRepository {
  /**
   * Loads one secret by name including a soft-deleted row.
   *
   * @param executor - Database or transaction.
   * @param projectId - Project identifier.
   * @param name - Secret name.
   * @returns The secret, or undefined.
   */
  public async findSecretByName(
    executor: QueryExecutor,
    projectId: string,
    name: string,
  ): Promise<SecretRecord | undefined> {
    const result = await executor.executeQuery<SecretRow>(
      `SELECT ${SECRET_COLUMNS} FROM secrets WHERE project_id = :projectId AND name = :name`,
      { projectId, name },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toSecret(row);
  }

  /**
   * Loads one active secret by name.
   *
   * @param executor - Database or transaction.
   * @param projectId - Project identifier.
   * @param name - Secret name.
   * @returns The active secret, or undefined.
   */
  public async findActiveSecret(
    executor: QueryExecutor,
    projectId: string,
    name: string,
  ): Promise<SecretRecord | undefined> {
    const result = await executor.executeQuery<SecretRow>(
      `SELECT ${SECRET_COLUMNS}
         FROM secrets
        WHERE project_id = :projectId AND name = :name AND deleted_at IS NULL`,
      { projectId, name },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toSecret(row);
  }

  /**
   * Loads one secret by id including a soft-deleted row.
   *
   * @param executor - Database or transaction.
   * @param id - Secret identifier.
   * @returns The secret, or undefined.
   */
  public async findSecretById(
    executor: QueryExecutor,
    id: string,
  ): Promise<SecretRecord | undefined> {
    const result = await executor.executeQuery<SecretRow>(
      `SELECT ${SECRET_COLUMNS} FROM secrets WHERE id = :id`,
      { id },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toSecret(row);
  }

  /**
   * Locks one secret row for a state transition.
   *
   * @param executor - Transaction.
   * @param id - Secret identifier.
   * @returns The locked secret, or undefined.
   */
  public async lockSecret(executor: QueryExecutor, id: string): Promise<SecretRecord | undefined> {
    const result = await executor.executeQuery<SecretRow>(
      `SELECT ${SECRET_COLUMNS} FROM secrets WHERE id = :id FOR UPDATE`,
      { id },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toSecret(row);
  }

  /**
   * Locks the active project row shared by every data write.
   *
   * @param executor - Transaction.
   * @param projectId - Project identifier.
   * @returns True when the project is active.
   */
  public async lockActiveProject(executor: QueryExecutor, projectId: string): Promise<boolean> {
    const result = await executor.executeQuery<{ id: string }>(
      "SELECT id FROM projects WHERE id = :projectId AND deleted_at IS NULL FOR SHARE",
      { projectId },
    );
    return result.records.length === 1;
  }

  /**
   * Serializes name-addressed lifecycle operations for one project and name.
   *
   * @param executor - Transaction.
   * @param projectId - Project identifier.
   * @param name - Secret name.
   */
  public async lockSecretName(
    executor: QueryExecutor,
    projectId: string,
    name: string,
  ): Promise<void> {
    await executor.executeQuery("SELECT pg_advisory_xact_lock(hashtext(:key)::bigint)", {
      key: `${projectId}:${name}`,
    });
  }

  /**
   * Inserts one secret row.
   *
   * @param executor - Transaction.
   * @param input - Secret fields.
   * @returns The inserted secret.
   */
  public async insertSecret(
    executor: QueryExecutor,
    input: {
      readonly id: string;
      readonly projectId: string;
      readonly name: string;
      readonly tags: Readonly<Record<string, string>>;
      readonly contentType: string;
    },
  ): Promise<SecretRecord> {
    const result = await executor.executeQuery<SecretRow>(
      `INSERT INTO secrets (id, project_id, name, tags, content_type, created_at, updated_at)
       VALUES (:id, :projectId, :name, :tags, :contentType, now(), now())
       RETURNING ${SECRET_COLUMNS}`,
      {
        id: input.id,
        projectId: input.projectId,
        name: input.name,
        tags: input.tags,
        contentType: input.contentType,
      },
    );
    const row = result.records[0];
    if (row === undefined) {
      throw new Error("Secret insert returned no row");
    }
    return toSecret(row);
  }

  /**
   * Inserts one immutable version.
   *
   * @param executor - Transaction.
   * @param input - Version fields.
   * @returns The inserted version.
   */
  public async insertVersion(
    executor: QueryExecutor,
    input: {
      readonly id: string;
      readonly secretId: string;
      readonly envelope: {
        readonly ciphertext: Buffer;
        readonly nonce: Buffer;
        readonly tag: Buffer;
        readonly wrappedDek: Buffer;
        readonly wrapNonce: Buffer;
        readonly wrapTag: Buffer;
        readonly kekId: string;
      };
      readonly createdBy: string;
      readonly expiresAt: Date | null;
    },
  ): Promise<SecretVersionRecord> {
    const result = await executor.executeQuery<VersionRow>(
      `INSERT INTO secret_versions
         (id, secret_id, ciphertext, nonce, tag, wrapped_dek, wrap_nonce, wrap_tag, kek_id,
          created_by, created_at, expires_at)
       VALUES
         (:id, :secretId, :ciphertext, :nonce, :tag, :wrappedDek, :wrapNonce, :wrapTag,
          :kekId, :createdBy, now(), :expiresAt)
       RETURNING ${VERSION_COLUMNS}`,
      {
        id: input.id,
        secretId: input.secretId,
        ...input.envelope,
        createdBy: input.createdBy,
        expiresAt: input.expiresAt,
      },
    );
    const row = result.records[0];
    if (row === undefined) {
      throw new Error("Version insert returned no row");
    }
    return toVersion(row);
  }

  /**
   * Moves the current-version pointer.
   *
   * @param executor - Transaction.
   * @param secretId - Secret identifier.
   * @param versionId - Version identifier.
   */
  public async updateCurrentVersion(
    executor: QueryExecutor,
    secretId: string,
    versionId: string,
  ): Promise<void> {
    await executor.executeQuery(
      "UPDATE secrets SET current_version_id = :versionId, updated_at = now() WHERE id = :secretId",
      { secretId, versionId },
    );
  }

  /**
   * Updates metadata without creating a version.
   *
   * @param executor - Transaction.
   * @param id - Secret identifier.
   * @param input - Full metadata values.
   * @returns The updated secret, or undefined when hidden.
   */
  public async updateMetadata(
    executor: QueryExecutor,
    id: string,
    input: {
      readonly tags: Readonly<Record<string, string>>;
      readonly contentType: string;
      readonly purgeProtected: boolean;
    },
  ): Promise<SecretRecord | undefined> {
    const result = await executor.executeQuery<SecretRow>(
      `UPDATE secrets
          SET tags = :tags, content_type = :contentType, purge_protected = :purgeProtected,
              updated_at = now()
        WHERE id = :id AND deleted_at IS NULL
        RETURNING ${SECRET_COLUMNS}`,
      { id, ...input },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toSecret(row);
  }

  /**
   * Soft-deletes one active secret using the database clock.
   *
   * @param executor - Transaction.
   * @param id - Secret identifier.
   * @param retentionDays - Retention window.
   * @returns The deleted row, or undefined when already hidden.
   */
  public async softDelete(
    executor: QueryExecutor,
    id: string,
    retentionDays: number,
  ): Promise<SecretRecord | undefined> {
    const result = await executor.executeQuery<SecretRow>(
      `UPDATE secrets
          SET deleted_at = now(),
              purge_after = now() + make_interval(days => :retentionDays),
              updated_at = now()
        WHERE id = :id AND deleted_at IS NULL
        RETURNING ${SECRET_COLUMNS}`,
      { id, retentionDays },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toSecret(row);
  }

  /**
   * Recovers one deleted secret before the retention boundary.
   *
   * @param executor - Transaction.
   * @param id - Secret identifier.
   * @returns The recovered row, or undefined when not recoverable.
   */
  public async recover(executor: QueryExecutor, id: string): Promise<SecretRecord | undefined> {
    const result = await executor.executeQuery<SecretRow>(
      `UPDATE secrets
          SET deleted_at = NULL, purge_after = NULL, updated_at = now()
        WHERE id = :id AND deleted_at IS NOT NULL AND purge_after > now()
        RETURNING ${SECRET_COLUMNS}`,
      { id },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toSecret(row);
  }

  /**
   * Counts every retained version for the limit.
   *
   * @param executor - Database or transaction.
   * @param secretId - Secret identifier.
   * @returns The version count.
   */
  public async countVersions(executor: QueryExecutor, secretId: string): Promise<number> {
    const result = await executor.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM secret_versions WHERE secret_id = :secretId",
      { secretId },
    );
    return result.records[0]?.count ?? 0;
  }

  /**
   * Finds one version belonging to a secret.
   *
   * @param executor - Database or transaction.
   * @param secretId - Secret identifier.
   * @param versionId - Version identifier.
   * @returns The version, or undefined.
   */
  public async findVersion(
    executor: QueryExecutor,
    secretId: string,
    versionId: string,
  ): Promise<SecretVersionRecord | undefined> {
    const result = await executor.executeQuery<VersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM secret_versions
        WHERE id = :versionId AND secret_id = :secretId`,
      { secretId, versionId },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toVersion(row);
  }

  /**
   * Finds one version by id together with its secret.
   *
   * @param executor - Database or transaction.
   * @param versionId - Version identifier.
   * @returns The version and secret, or undefined.
   */
  public async findVersionById(
    executor: QueryExecutor,
    versionId: string,
  ): Promise<
    { readonly version: SecretVersionMetadata; readonly secret: SecretRecord } | undefined
  > {
    const result = await executor.executeQuery<VersionMetadataRow>(
      `SELECT ${VERSION_METADATA_COLUMNS} FROM secret_versions WHERE id = :versionId`,
      { versionId },
    );
    const row = result.records[0];
    if (row === undefined) {
      return undefined;
    }
    const secret = await this.findSecretById(executor, row.secret_id);
    return secret === undefined ? undefined : { version: toVersionMetadata(row), secret };
  }

  /**
   * Finds one version's metadata by secret and id.
   *
   * @param executor - Database or transaction.
   * @param secretId - Secret identifier.
   * @param versionId - Version identifier.
   * @returns The metadata, or undefined.
   */
  public async findVersionMetadata(
    executor: QueryExecutor,
    secretId: string,
    versionId: string,
  ): Promise<SecretVersionMetadata | undefined> {
    const result = await executor.executeQuery<VersionMetadataRow>(
      `SELECT ${VERSION_METADATA_COLUMNS}
         FROM secret_versions
        WHERE id = :versionId AND secret_id = :secretId`,
      { secretId, versionId },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toVersionMetadata(row);
  }

  /**
   * Finds the newest unexpired version.
   *
   * @param executor - Database or transaction.
   * @param secretId - Secret identifier.
   * @returns The newest active version, or undefined.
   */
  public async findLatestActiveVersion(
    executor: QueryExecutor,
    secretId: string,
  ): Promise<SecretVersionRecord | undefined> {
    const result = await executor.executeQuery<VersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM secret_versions
        WHERE secret_id = :secretId AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      { secretId },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toVersion(row);
  }

  /**
   * Lists every version newest first.
   *
   * @param executor - Database or transaction.
   * @param secretId - Secret identifier.
   * @returns The versions.
   */
  public async listVersions(
    executor: QueryExecutor,
    secretId: string,
  ): Promise<readonly SecretVersionMetadata[]> {
    const result = await executor.executeQuery<VersionMetadataRow>(
      `SELECT ${VERSION_METADATA_COLUMNS}
         FROM secret_versions
        WHERE secret_id = :secretId
        ORDER BY created_at DESC, id DESC`,
      { secretId },
    );
    return result.records.map(toVersionMetadata);
  }

  /**
   * Lists active secrets with the optional search, tag, and cursor filters.
   *
   * @param executor - Database.
   * @param projectId - Project identifier.
   * @param filters - Search and cursor values.
   * @returns Matching rows plus the current version.
   */
  public async listActiveSecrets(
    executor: QueryExecutor,
    projectId: string,
    filters: {
      readonly q?: string | undefined;
      readonly tagKey?: string | undefined;
      readonly tagValue?: string | undefined;
      readonly cursor?: ListCursor | undefined;
      readonly limit: number;
    },
  ): Promise<readonly SecretListRow[]> {
    const conditions = ["s.project_id = :projectId", "s.deleted_at IS NULL"];
    const params: Record<string, unknown> = { projectId, limit: filters.limit + 1 };
    if (filters.q !== undefined) {
      conditions.push("s.name ILIKE :pattern ESCAPE '\\'");
      params.pattern = `%${filters.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    }
    if (filters.tagKey !== undefined) {
      if (filters.tagValue === undefined) {
        conditions.push("s.tags ? :tagKey");
        params.tagKey = filters.tagKey;
      } else {
        conditions.push("s.tags ->> :tagKey = :tagValue");
        params.tagKey = filters.tagKey;
        params.tagValue = filters.tagValue;
      }
    }
    if (filters.cursor !== undefined) {
      conditions.push("(s.name, s.id) > (:afterName, :afterId)");
      params.afterName = filters.cursor.name;
      params.afterId = filters.cursor.id;
    }
    const result = await executor.executeQuery<ListRow>(
      `SELECT s.id, s.project_id, s.name, s.tags, s.content_type, s.current_version_id,
              s.purge_protected, s.created_at, s.updated_at, s.deleted_at, s.purge_after,
              cv.id AS cv_id, cv.created_by AS cv_created_by,
              cv.created_at AS cv_created_at, cv.expires_at AS cv_expires_at
         FROM secrets s
         LEFT JOIN secret_versions cv ON cv.id = s.current_version_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY s.name ASC, s.id ASC
        LIMIT :limit`,
      params,
    );
    return result.records.map((row) => ({
      ...listRowToSecret(row),
      currentVersion: listRowToVersion(row),
    }));
  }

  /**
   * Lists consumer summaries for the given secrets.
   *
   * @param executor - Database.
   * @param projectId - Project identifier.
   * @param secretIds - Secrets to summarize.
   * @returns A map keyed by secret id.
   */
  public async listConsumers(
    executor: QueryExecutor,
    projectId: string,
    secretIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly ConsumerSummary[]>> {
    const result = new Map<string, ConsumerSummary[]>();
    if (secretIds.length === 0) {
      return result;
    }
    const rows = await executor.executeQuery<{
      readonly secret_id: string;
      readonly compose_project: string;
      readonly compose_service: string;
      readonly last_seen: Date;
    }>(
      `SELECT secret_id, compose_project, compose_service, last_seen
         FROM secret_consumer_summaries
        WHERE project_id = :projectId AND secret_id = ANY(:secretIds)
        ORDER BY compose_project ASC, compose_service ASC`,
      { projectId, secretIds: [...secretIds] },
    );
    for (const row of rows.records) {
      const list = result.get(row.secret_id) ?? [];
      list.push({
        composeProject: row.compose_project,
        composeService: row.compose_service,
        lastSeen: row.last_seen,
      });
      result.set(row.secret_id, list);
    }
    return result;
  }
}
