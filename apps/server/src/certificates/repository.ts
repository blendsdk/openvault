/** Minimal query surface shared by repositories and transactions. */
export interface QueryExecutor {
  /** Executes a named-parameter query. */
  executeQuery<T>(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<{ readonly records: readonly T[]; readonly rowCount?: number | null }>;
}

/** A certificate row. */
export interface CertificateRecord {
  /** Certificate identifier. */
  readonly id: string;
  /** Owning project. */
  readonly projectId: string;
  /** Certificate name. */
  readonly name: string;
  /** Tags. */
  readonly tags: Readonly<Record<string, string>>;
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

/** One immutable certificate version with its encrypted private key. */
export interface CertificateVersionRecord {
  /** Version identifier. */
  readonly id: string;
  /** Owning certificate. */
  readonly certificateId: string;
  /** Stored leaf plus non-leaf PEM blocks. */
  readonly chainPem: string;
  /** Number of PEM blocks. */
  readonly chainLength: number;
  /** Encrypted PKCS#8 key. */
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
  /** Leaf fingerprint. */
  readonly fingerprint: string;
  /** Leaf subject. */
  readonly subject: string;
  /** Leaf SANs. */
  readonly sans: readonly string[];
  /** Leaf issuer. */
  readonly issuer: string;
  /** Leaf serial. */
  readonly serial: string;
  /** Validity start. */
  readonly notBefore: Date;
  /** Validity end. */
  readonly notAfter: Date;
  /** Creator principal. */
  readonly createdBy: string;
  /** Creation time. */
  readonly createdAt: Date;
}

/** Version metadata without ciphertext. */
export interface CertificateVersionMetadata {
  /** Version identifier. */
  readonly id: string;
  /** Owning certificate. */
  readonly certificateId: string;
  /** Leaf fingerprint. */
  readonly fingerprint: string;
  /** Leaf subject. */
  readonly subject: string;
  /** Leaf SANs. */
  readonly sans: readonly string[];
  /** Leaf issuer. */
  readonly issuer: string;
  /** Leaf serial. */
  readonly serial: string;
  /** Validity start. */
  readonly notBefore: Date;
  /** Validity end. */
  readonly notAfter: Date;
  /** Creator principal. */
  readonly createdBy: string;
  /** Creation time. */
  readonly createdAt: Date;
  /** Number of PEM blocks. */
  readonly chainLength: number;
}

/** A certificate list row with its current version metadata. */
export interface CertificateListRow extends CertificateRecord {
  /** Current version metadata, when present. */
  readonly currentVersion: CertificateVersionMetadata | null;
}

/** Database-clock purge state. */
export interface CertificatePurgeState {
  /** Soft-delete time, or null. */
  readonly deletedAt: Date | null;
  /** Purge protection flag. */
  readonly purgeProtected: boolean;
  /** Earliest purge time, or null. */
  readonly purgeAfter: Date | null;
  /** Database clock at read time. */
  readonly databaseNow: Date;
}

/** Decoded list cursor. */
export interface CertificateCursor {
  /** Last name on the previous page. */
  readonly name: string;
  /** Last id on the previous page. */
  readonly id: string;
}

interface CertificateRow {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly tags: Record<string, string>;
  readonly current_version_id: string | null;
  readonly purge_protected: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly deleted_at: Date | null;
  readonly purge_after: Date | null;
}

interface VersionRow {
  readonly id: string;
  readonly certificate_id: string;
  readonly chain_pem: string;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly wrapped_dek: Buffer;
  readonly wrap_nonce: Buffer;
  readonly wrap_tag: Buffer;
  readonly kek_id: string;
  readonly fingerprint: string;
  readonly subject: string;
  readonly sans: unknown;
  readonly issuer: string;
  readonly serial: string;
  readonly not_before: Date;
  readonly not_after: Date;
  readonly created_by: string;
  readonly created_at: Date;
}

interface VersionMetadataRow {
  readonly id: string;
  readonly certificate_id: string;
  readonly chain_pem: string;
  readonly fingerprint: string;
  readonly subject: string;
  readonly sans: unknown;
  readonly issuer: string;
  readonly serial: string;
  readonly not_before: Date;
  readonly not_after: Date;
  readonly created_by: string;
  readonly created_at: Date;
}

interface ListRow extends CertificateRow {
  readonly cv_id: string | null;
  readonly cv_chain_pem: string | null;
  readonly cv_fingerprint: string | null;
  readonly cv_subject: string | null;
  readonly cv_sans: unknown;
  readonly cv_issuer: string | null;
  readonly cv_serial: string | null;
  readonly cv_not_before: Date | null;
  readonly cv_not_after: Date | null;
  readonly cv_created_by: string | null;
  readonly cv_created_at: Date | null;
}

const CERTIFICATE_COLUMNS = `id, project_id, name, tags, current_version_id, purge_protected,
  created_at, updated_at, deleted_at, purge_after`;
const VERSION_COLUMNS = `id, certificate_id, chain_pem, ciphertext, nonce, tag, wrapped_dek,
  wrap_nonce, wrap_tag, kek_id, fingerprint, subject, sans, issuer, serial, not_before,
  not_after, created_by, created_at`;
const VERSION_METADATA_COLUMNS = `id, certificate_id, chain_pem, fingerprint, subject, sans,
  issuer, serial, not_before, not_after, created_by, created_at`;

function toCertificate(row: CertificateRow): CertificateRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    tags: row.tags,
    currentVersionId: row.current_version_id,
    purgeProtected: row.purge_protected,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after,
  };
}

/** Narrows a JSONB SAN column to a string array. */
function toSans(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Stored certificate SANs are invalid");
  }
  return value;
}

function toVersion(row: VersionRow): CertificateVersionRecord {
  return {
    id: row.id,
    certificateId: row.certificate_id,
    chainPem: row.chain_pem,
    chainLength: countPemBlocks(row.chain_pem),
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    tag: row.tag,
    wrappedDek: row.wrapped_dek,
    wrapNonce: row.wrap_nonce,
    wrapTag: row.wrap_tag,
    kekId: row.kek_id,
    fingerprint: row.fingerprint,
    subject: row.subject,
    sans: toSans(row.sans),
    issuer: row.issuer,
    serial: row.serial,
    notBefore: row.not_before,
    notAfter: row.not_after,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function countPemBlocks(value: string): number {
  return value.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0;
}

function toVersionMetadata(row: VersionMetadataRow): CertificateVersionMetadata {
  return {
    id: row.id,
    certificateId: row.certificate_id,
    fingerprint: row.fingerprint,
    subject: row.subject,
    sans: toSans(row.sans),
    issuer: row.issuer,
    serial: row.serial,
    notBefore: row.not_before,
    notAfter: row.not_after,
    createdBy: row.created_by,
    createdAt: row.created_at,
    chainLength: countPemBlocks(row.chain_pem),
  };
}

function listRowToVersion(row: ListRow): CertificateVersionMetadata | null {
  if (
    row.cv_id === null ||
    row.cv_chain_pem === null ||
    row.cv_fingerprint === null ||
    row.cv_subject === null ||
    row.cv_issuer === null ||
    row.cv_serial === null ||
    row.cv_not_before === null ||
    row.cv_not_after === null ||
    row.cv_created_by === null ||
    row.cv_created_at === null
  ) {
    return null;
  }
  return {
    id: row.cv_id,
    certificateId: row.id,
    fingerprint: row.cv_fingerprint,
    subject: row.cv_subject,
    sans: toSans(row.cv_sans),
    issuer: row.cv_issuer,
    serial: row.cv_serial,
    notBefore: row.cv_not_before,
    notAfter: row.cv_not_after,
    createdBy: row.cv_created_by,
    createdAt: row.cv_created_at,
    chainLength: countPemBlocks(row.cv_chain_pem),
  };
}

/**
 * Reads and mutates certificates and their immutable versions.
 *
 * Every mutation takes an explicit transaction so the parent row, version, current pointer,
 * and joined audit decision commit together.
 */
export class CertificateRepository {
  /**
   * Loads one certificate by name including a soft-deleted row.
   *
   * @param executor - Database or transaction.
   * @param projectId - Project identifier.
   * @param name - Certificate name.
   * @returns The certificate, or undefined.
   */
  public async findCertificateByName(
    executor: QueryExecutor,
    projectId: string,
    name: string,
  ): Promise<CertificateRecord | undefined> {
    const result = await executor.executeQuery<CertificateRow>(
      `SELECT ${CERTIFICATE_COLUMNS} FROM certificates
        WHERE project_id = :projectId AND name = :name`,
      { projectId, name },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toCertificate(row);
  }

  /**
   * Loads one active certificate by name.
   *
   * @param executor - Database or transaction.
   * @param projectId - Project identifier.
   * @param name - Certificate name.
   * @returns The active certificate, or undefined.
   */
  public async findActiveCertificateByName(
    executor: QueryExecutor,
    projectId: string,
    name: string,
  ): Promise<CertificateRecord | undefined> {
    const result = await executor.executeQuery<CertificateRow>(
      `SELECT ${CERTIFICATE_COLUMNS} FROM certificates
        WHERE project_id = :projectId AND name = :name AND deleted_at IS NULL`,
      { projectId, name },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toCertificate(row);
  }

  /**
   * Loads one certificate by id including a soft-deleted row.
   *
   * @param executor - Database or transaction.
   * @param id - Certificate identifier.
   * @returns The certificate, or undefined.
   */
  public async findCertificateById(
    executor: QueryExecutor,
    id: string,
  ): Promise<CertificateRecord | undefined> {
    const result = await executor.executeQuery<CertificateRow>(
      `SELECT ${CERTIFICATE_COLUMNS} FROM certificates WHERE id = :id`,
      { id },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toCertificate(row);
  }

  /**
   * Locks one active project shared by every data write.
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
   * @param name - Certificate name.
   */
  public async lockCertificateName(
    executor: QueryExecutor,
    projectId: string,
    name: string,
  ): Promise<void> {
    await executor.executeQuery("SELECT pg_advisory_xact_lock(hashtext(:key)::bigint)", {
      key: `${projectId}:${name}`,
    });
  }

  /**
   * Locks one certificate row.
   *
   * @param executor - Transaction.
   * @param id - Certificate identifier.
   * @returns The locked row, or undefined.
   */
  public async lockCertificate(
    executor: QueryExecutor,
    id: string,
  ): Promise<CertificateRecord | undefined> {
    const result = await executor.executeQuery<CertificateRow>(
      `SELECT ${CERTIFICATE_COLUMNS} FROM certificates WHERE id = :id FOR UPDATE`,
      { id },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toCertificate(row);
  }

  /**
   * Inserts one certificate parent row.
   *
   * @param executor - Transaction.
   * @param input - Identifier, project, name, and tags.
   * @returns The inserted row.
   */
  public async insertCertificate(
    executor: QueryExecutor,
    input: {
      readonly id: string;
      readonly projectId: string;
      readonly name: string;
      readonly tags: Readonly<Record<string, string>>;
    },
  ): Promise<CertificateRecord> {
    const result = await executor.executeQuery<CertificateRow>(
      `INSERT INTO certificates (id, project_id, name, tags, created_at, updated_at)
       VALUES (:id, :projectId, :name, :tags, now(), now())
       RETURNING ${CERTIFICATE_COLUMNS}`,
      { ...input },
    );
    const row = result.records[0];
    if (row === undefined) {
      throw new Error("Certificate insert returned no row");
    }
    return toCertificate(row);
  }

  /**
   * Inserts one immutable certificate version.
   *
   * @param executor - Transaction.
   * @param input - Version metadata and encrypted private key.
   * @returns The inserted version.
   */
  public async insertVersion(
    executor: QueryExecutor,
    input: {
      readonly id: string;
      readonly certificateId: string;
      readonly chainPem: string;
      readonly envelope: {
        readonly ciphertext: Buffer;
        readonly nonce: Buffer;
        readonly tag: Buffer;
        readonly wrappedDek: Buffer;
        readonly wrapNonce: Buffer;
        readonly wrapTag: Buffer;
        readonly kekId: string;
      };
      readonly subject: string;
      readonly sans: readonly string[];
      readonly issuer: string;
      readonly serial: string;
      readonly fingerprint: string;
      readonly notBefore: Date;
      readonly notAfter: Date;
      readonly createdBy: string;
    },
  ): Promise<CertificateVersionRecord> {
    const result = await executor.executeQuery<VersionRow>(
      `INSERT INTO certificate_versions
         (id, certificate_id, chain_pem, ciphertext, nonce, tag, wrapped_dek, wrap_nonce,
          wrap_tag, kek_id, fingerprint, subject, sans, issuer, serial, not_before,
          not_after, created_by, created_at)
       VALUES
         (:id, :certificateId, :chainPem, :ciphertext, :nonce, :tag, :wrappedDek, :wrapNonce,
          :wrapTag, :kekId, :fingerprint, :subject, :sans, :issuer, :serial, :notBefore,
          :notAfter, :createdBy, now())
       RETURNING ${VERSION_COLUMNS}`,
      {
        id: input.id,
        certificateId: input.certificateId,
        chainPem: input.chainPem,
        ...input.envelope,
        fingerprint: input.fingerprint,
        subject: input.subject,
        sans: JSON.stringify(input.sans),
        issuer: input.issuer,
        serial: input.serial,
        notBefore: input.notBefore,
        notAfter: input.notAfter,
        createdBy: input.createdBy,
      },
    );
    const row = result.records[0];
    if (row === undefined) {
      throw new Error("Certificate version insert returned no row");
    }
    return toVersion(row);
  }

  /**
   * Moves the current-version pointer.
   *
   * @param executor - Transaction.
   * @param certificateId - Certificate identifier.
   * @param versionId - Version identifier.
   */
  public async updateCurrentVersion(
    executor: QueryExecutor,
    certificateId: string,
    versionId: string,
  ): Promise<void> {
    await executor.executeQuery(
      "UPDATE certificates SET current_version_id = :versionId, updated_at = now() WHERE id = :certificateId",
      { certificateId, versionId },
    );
  }

  /**
   * Updates tags and one-way protection.
   *
   * @param executor - Transaction.
   * @param id - Certificate identifier.
   * @param input - Replacement tags and protection value.
   * @returns The updated row, or undefined when hidden.
   */
  public async updateMetadata(
    executor: QueryExecutor,
    id: string,
    input: {
      readonly tags: Readonly<Record<string, string>>;
      readonly purgeProtected: boolean;
    },
  ): Promise<CertificateRecord | undefined> {
    const result = await executor.executeQuery<CertificateRow>(
      `UPDATE certificates
          SET tags = :tags, purge_protected = :purgeProtected, updated_at = now()
        WHERE id = :id AND deleted_at IS NULL
        RETURNING ${CERTIFICATE_COLUMNS}`,
      { id, ...input },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toCertificate(row);
  }

  /**
   * Soft-deletes one active certificate using the database clock.
   *
   * @param executor - Transaction.
   * @param id - Certificate identifier.
   * @param retentionDays - Retention window.
   * @returns The deleted row, or undefined.
   */
  public async softDelete(
    executor: QueryExecutor,
    id: string,
    retentionDays: number,
  ): Promise<CertificateRecord | undefined> {
    const result = await executor.executeQuery<CertificateRow>(
      `UPDATE certificates
          SET deleted_at = now(),
              purge_after = now() + make_interval(days => :retentionDays),
              updated_at = now()
        WHERE id = :id AND deleted_at IS NULL
        RETURNING ${CERTIFICATE_COLUMNS}`,
      { id, retentionDays },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toCertificate(row);
  }

  /**
   * Recovers one deleted certificate before retention expires.
   *
   * @param executor - Transaction.
   * @param id - Certificate identifier.
   * @returns The recovered row, or undefined.
   */
  public async recover(
    executor: QueryExecutor,
    id: string,
  ): Promise<CertificateRecord | undefined> {
    const result = await executor.executeQuery<CertificateRow>(
      `UPDATE certificates
          SET deleted_at = NULL, purge_after = NULL, updated_at = now()
        WHERE id = :id AND deleted_at IS NOT NULL AND purge_after > now()
        RETURNING ${CERTIFICATE_COLUMNS}`,
      { id },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toCertificate(row);
  }

  /**
   * Deletes expiry-notification rows for superseded versions.
   *
   * @param executor - Transaction.
   * @param certificateId - Certificate identifier.
   * @param currentVersionId - Newly current version.
   */
  public async deleteSupersededNotifications(
    executor: QueryExecutor,
    certificateId: string,
    currentVersionId: string,
  ): Promise<void> {
    await executor.executeQuery(
      `DELETE FROM certificate_expiry_notifications
        WHERE certificate_id = :certificateId AND version_id <> :currentVersionId`,
      { certificateId, currentVersionId },
    );
  }

  /**
   * Reads purge eligibility using the database clock.
   *
   * @param executor - Database or transaction.
   * @param id - Certificate identifier.
   * @returns The state, or undefined.
   */
  public async purgeState(
    executor: QueryExecutor,
    id: string,
  ): Promise<CertificatePurgeState | undefined> {
    const result = await executor.executeQuery<{
      deleted_at: Date | null;
      purge_protected: boolean;
      purge_after: Date | null;
      database_now: Date;
    }>(
      `SELECT deleted_at, purge_protected, purge_after, now() AS database_now
         FROM certificates WHERE id = :id`,
      { id },
    );
    const row = result.records[0];
    return row === undefined
      ? undefined
      : {
          deletedAt: row.deleted_at,
          purgeProtected: row.purge_protected,
          purgeAfter: row.purge_after,
          databaseNow: row.database_now,
        };
  }

  /**
   * Counts every retained version.
   *
   * @param executor - Database or transaction.
   * @param certificateId - Certificate identifier.
   * @returns The version count.
   */
  public async countVersions(executor: QueryExecutor, certificateId: string): Promise<number> {
    const result = await executor.executeQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM certificate_versions WHERE certificate_id = :certificateId",
      { certificateId },
    );
    return result.records[0]?.count ?? 0;
  }

  /**
   * Finds one version belonging to a certificate, including ciphertext.
   *
   * @param executor - Database or transaction.
   * @param certificateId - Certificate identifier.
   * @param versionId - Version identifier.
   * @returns The version, or undefined.
   */
  public async findVersion(
    executor: QueryExecutor,
    certificateId: string,
    versionId: string,
  ): Promise<CertificateVersionRecord | undefined> {
    const result = await executor.executeQuery<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM certificate_versions
        WHERE id = :versionId AND certificate_id = :certificateId`,
      { certificateId, versionId },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toVersion(row);
  }

  /**
   * Finds one version's metadata by certificate and id.
   *
   * @param executor - Database or transaction.
   * @param certificateId - Certificate identifier.
   * @param versionId - Version identifier.
   * @returns The metadata, or undefined.
   */
  public async findVersionMetadata(
    executor: QueryExecutor,
    certificateId: string,
    versionId: string,
  ): Promise<CertificateVersionMetadata | undefined> {
    const result = await executor.executeQuery<VersionMetadataRow>(
      `SELECT ${VERSION_METADATA_COLUMNS} FROM certificate_versions
        WHERE id = :versionId AND certificate_id = :certificateId`,
      { certificateId, versionId },
    );
    const row = result.records[0];
    return row === undefined ? undefined : toVersionMetadata(row);
  }

  /**
   * Lists active certificates with search, SAN, expiry, and cursor filters.
   *
   * @param executor - Database.
   * @param projectId - Project identifier.
   * @param filters - Query filters.
   * @returns Matching rows and their current version metadata.
   */
  public async listActiveCertificates(
    executor: QueryExecutor,
    projectId: string,
    filters: {
      readonly q?: string | undefined;
      readonly san?: string | undefined;
      readonly expiresBefore?: string | undefined;
      readonly expiresAfter?: string | undefined;
      readonly cursor?: CertificateCursor | undefined;
      readonly limit: number;
    },
  ): Promise<readonly CertificateListRow[]> {
    const conditions = ["c.project_id = :projectId", "c.deleted_at IS NULL"];
    const params: Record<string, unknown> = { projectId, limit: filters.limit + 1 };
    if (filters.q !== undefined) {
      conditions.push("v.subject ILIKE :pattern ESCAPE '\\'");
      params.pattern = `%${filters.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    }
    if (filters.san !== undefined) {
      conditions.push(
        "EXISTS (SELECT 1 FROM jsonb_array_elements_text(v.sans) AS san(value) WHERE lower(san.value) = lower(:san))",
      );
      params.san = filters.san;
    }
    if (filters.expiresAfter !== undefined) {
      conditions.push("v.not_after >= :expiresAfter");
      params.expiresAfter = filters.expiresAfter;
    }
    if (filters.expiresBefore !== undefined) {
      conditions.push("v.not_after <= :expiresBefore");
      params.expiresBefore = filters.expiresBefore;
    }
    if (filters.cursor !== undefined) {
      conditions.push("(c.name, c.id) > (:afterName, :afterId)");
      params.afterName = filters.cursor.name;
      params.afterId = filters.cursor.id;
    }
    const result = await executor.executeQuery<ListRow>(
      `SELECT c.id, c.project_id, c.name, c.tags, c.current_version_id, c.purge_protected,
              c.created_at, c.updated_at, c.deleted_at, c.purge_after,
              v.id AS cv_id, v.chain_pem AS cv_chain_pem,
              v.fingerprint AS cv_fingerprint, v.subject AS cv_subject,
              v.sans AS cv_sans, v.issuer AS cv_issuer, v.serial AS cv_serial,
              v.not_before AS cv_not_before, v.not_after AS cv_not_after,
              v.created_by AS cv_created_by, v.created_at AS cv_created_at
         FROM certificates c
         LEFT JOIN certificate_versions v ON v.id = c.current_version_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY c.name ASC, c.id ASC
        LIMIT :limit`,
      params,
    );
    return result.records.map((row) => ({
      ...toCertificate(row),
      currentVersion: listRowToVersion(row),
    }));
  }
}
