import { createPrivateKey } from "node:crypto";
import type {
  CapabilityFlags,
  CertificateGenerateInput,
  CertificateImportInput,
  CertificateList,
  CertificateListQuery,
  CertificateMetadata,
  CertificatePrivateKeyResponse,
  CertificatePublicResponse,
  CertificateReadQuery,
  CertificateVersion,
  CertificateWriteResponse,
} from "@openvault/api-contract";
import { certificateNameSchema, projectNameSchema, ulidSchema } from "@openvault/api-contract";
import {
  decryptValue,
  type EnvelopeKeyring,
  encryptValue,
  KeyringError,
  newUlid,
} from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { AuditWriter } from "../audit/audit-writer.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { PolicyAuditContext } from "../rbac/audit.js";
import { canListCollection } from "../rbac/collection-visibility.js";
import { PolicyUnavailableError } from "../rbac/errors.js";
import type { PolicyDecision, PolicyService } from "../rbac/policy-service.js";
import { fromStoredCertificateEnvelope, toStoredCertificateEnvelope } from "./envelope.js";
import { CertificateServiceError } from "./errors.js";
import { generateSelfSignedCertificate } from "./generate.js";
import { type ParsedCertificateMaterial, parseCertificateMaterial, splitChainPem } from "./pem.js";
import type {
  CertificateCursor,
  CertificateRecord,
  CertificateRepository,
  CertificateVersionMetadata,
  CertificateVersionRecord,
} from "./repository.js";

const DAY_MS = 86_400_000;
const MAX_VERSIONS = 1_000;
const MAX_CERTIFICATE_CIPHERTEXT = 131_072;
const ZERO_CAPABILITIES: CapabilityFlags = {
  canRead: false,
  canWrite: false,
  canDelete: false,
  canPurge: false,
  canManage: false,
};
const CERTIFICATE_ACTIONS = [
  "certificate.write",
  "certificate.read",
  "certificate.read_private",
  "certificate.delete",
  "certificate.recover",
  "certificate.purge",
] as const;

/** Options for {@link CertificateService}. */
export interface CertificateServiceOptions {
  /** Connected database. */
  readonly database: PostgreSQLDatabase;
  /** Loaded keyring. */
  readonly keyring: EnvelopeKeyring;
  /** Policy engine. */
  readonly policy: PolicyService;
  /** Chain writer used for independent error outcomes. */
  readonly audit: AuditWriter;
  /** Project lookup. */
  readonly projectRepository: ProjectRepository;
  /** Certificate persistence. */
  readonly repository: CertificateRepository;
  /** PEM size bound. */
  readonly certMaxBytes: number;
  /** Injectable clock in milliseconds since the Unix epoch. */
  readonly now?: () => number;
}

/** One create-or-renew result. */
export interface CertificateWriteResult {
  /** True when a new certificate row was created. */
  readonly created: boolean;
  /** Public response. */
  readonly response: CertificateWriteResponse;
}

/** Returns true for a PostgreSQL unique violation. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "23505";
}

/** Maps a denial to the published visibility status. */
function denialError(
  notFoundCode: "project_not_found" | "certificate_not_found",
  hideExistence: boolean,
  message = "Resource not found",
): CertificateServiceError {
  if (hideExistence) {
    return new CertificateServiceError(404, notFoundCode, message);
  }
  return new CertificateServiceError(403, "access_denied", "Access denied");
}

/** Encodes one list cursor. */
function encodeCursor(cursor: CertificateCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Decodes one list cursor or throws a validation error. */
function decodeCursor(raw: string | undefined): CertificateCursor | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("invalid");
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.name !== "string" ||
      !certificateNameSchema.safeParse(record.name).success ||
      typeof record.id !== "string" ||
      !ulidSchema.safeParse(record.id).success
    ) {
      throw new Error("invalid");
    }
    return { name: record.name, id: record.id };
  } catch {
    throw new CertificateServiceError(422, "validation_error", "Validation failed");
  }
}

/**
 * Certificate data-plane service.
 *
 * Writes take the audit chain lock before data locks, commit one joined allow on success, and
 * write one independent error outcome on failure. Public reads write one allow before
 * returning the chain; private reads decrypt first, then write one allow, so a tampered
 * envelope is reported as an error rather than an allow.
 */
export class CertificateService {
  readonly #database: PostgreSQLDatabase;
  readonly #keyring: EnvelopeKeyring;
  readonly #policy: PolicyService;
  readonly #audit: AuditWriter;
  readonly #projectRepository: ProjectRepository;
  readonly #repository: CertificateRepository;
  readonly #certMaxBytes: number;
  readonly #now: () => number;

  /**
   * @param options - Database, keyring, policy, audit, repositories, and limits.
   */
  public constructor(options: CertificateServiceOptions) {
    this.#database = options.database;
    this.#keyring = options.keyring;
    this.#policy = options.policy;
    this.#audit = options.audit;
    this.#projectRepository = options.projectRepository;
    this.#repository = options.repository;
    this.#certMaxBytes = options.certMaxBytes;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Imports one certificate and private key, creating or renewing by name.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param input - Import request.
   * @param context - Optional request metadata.
   * @returns The created or renewed certificate.
   */
  public async import(
    actorId: string,
    projectName: string,
    input: CertificateImportInput,
    context?: PolicyAuditContext,
  ): Promise<CertificateWriteResult> {
    const project = await this.#activeProject(projectName);
    const pre = await this.#preAuthorizeProject(actorId, "certificate.write", project.id, context);
    let material: ParsedCertificateMaterial;
    try {
      material = await parseCertificateMaterial({
        certificatePem: input.certificatePem,
        ...(input.chainPem === undefined ? {} : { chainPem: input.chainPem }),
        privateKeyPem: input.privateKeyPem,
        allowNotYetValid: input.allowNotYetValid ?? false,
        now: this.#now(),
        maximumBytes: this.#certMaxBytes,
      });
    } catch (error) {
      await this.#recordError(
        actorId,
        pre,
        "certificate.write",
        project.id,
        newUlid(),
        error instanceof CertificateServiceError ? error.code : "validation_error",
        context,
      );
      throw error;
    }
    try {
      return await this.#write(actorId, project.id, projectName, input.name, material, {
        mode: "import",
        expectedVersionId: input.expectedVersionId,
        tags: input.tags,
        context,
      });
    } finally {
      material.privateKeyBytes.fill(0);
    }
  }

  /**
   * Generates one self-signed certificate, creating or renewing by name.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param input - Generation request.
   * @param context - Optional request metadata.
   * @returns The created or renewed certificate.
   */
  public async generate(
    actorId: string,
    projectName: string,
    input: CertificateGenerateInput,
    context?: PolicyAuditContext,
  ): Promise<CertificateWriteResult> {
    const project = await this.#activeProject(projectName);
    const pre = await this.#preAuthorizeProject(actorId, "certificate.write", project.id, context);
    let generated: Awaited<ReturnType<typeof generateSelfSignedCertificate>>;
    try {
      generated = await generateSelfSignedCertificate({
        subject: input.subject,
        sans: input.sans,
        keyType: input.keyType ?? "ec-p256",
        validityDays: input.validityDays ?? 365,
        maximumBytes: this.#certMaxBytes,
        now: this.#now(),
      });
    } catch (error) {
      await this.#recordError(
        actorId,
        pre,
        "certificate.write",
        project.id,
        newUlid(),
        error instanceof CertificateServiceError ? error.code : "validation_error",
        context,
      );
      throw error;
    }
    const material: ParsedCertificateMaterial = {
      leafPem: generated.certificatePem,
      certificateChainPem: generated.certificatePem,
      chainLength: 1,
      warnings: generated.warnings,
      subject: generated.subject,
      sans: generated.sans,
      issuer: generated.certificatePem === "" ? "" : generated.subject,
      serial: generated.serial,
      fingerprint: generated.fingerprint,
      notBefore: generated.notBefore,
      notAfter: generated.notAfter,
      privateKeyPem: generated.privateKeyPem,
      privateKeyBytes: generated.privateKeyBytes,
      privateKeyType: generated.keyType,
    };
    try {
      return await this.#write(actorId, project.id, projectName, input.name, material, {
        mode: "generate",
        expectedVersionId: input.expectedVersionId,
        tags: input.tags,
        context,
      });
    } finally {
      material.privateKeyBytes.fill(0);
    }
  }

  /** Shared create-or-renew transaction. */
  async #write(
    actorId: string,
    projectId: string,
    _projectName: string,
    name: string,
    material: ParsedCertificateMaterial,
    options: {
      readonly mode: "import" | "generate";
      readonly expectedVersionId?: string | undefined;
      readonly tags?: Readonly<Record<string, string>> | undefined;
      readonly context?: PolicyAuditContext | undefined;
    },
  ): Promise<CertificateWriteResult> {
    const existing = await this.#repository.findCertificateByName(this.#database, projectId, name);
    const certificateId = existing?.id ?? newUlid();
    const decision = await this.#policy.authorize(
      actorId,
      "certificate.write",
      { type: "certificate", id: certificateId, projectId },
      options.context,
      { audit: false },
    );
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, options.context);
      throw await this.#denyName(decision, projectId, options.context);
    }
    let created = existing === undefined;
    try {
      const outcome = await this.#database.withTransaction(async (tx) => {
        await this.#audit.lockChain(tx);
        if (!(await this.#repository.lockActiveProject(tx, projectId))) {
          throw new CertificateServiceError(404, "project_not_found", "Project not found");
        }
        await this.#repository.lockCertificateName(tx, projectId, name);
        const current = await this.#repository.findCertificateByName(tx, projectId, name);
        if (current !== undefined && current.deletedAt !== null) {
          throw new CertificateServiceError(
            409,
            "certificate_name_conflict",
            "Certificate name conflict",
          );
        }
        if (current !== undefined && current.id !== certificateId) {
          throw new CertificateServiceError(
            409,
            "certificate_version_conflict",
            "Certificate changed",
          );
        }
        if (
          options.expectedVersionId !== undefined &&
          current?.currentVersionId !== options.expectedVersionId
        ) {
          throw new CertificateServiceError(
            409,
            "certificate_version_conflict",
            "Certificate changed",
          );
        }
        let certificate: CertificateRecord;
        if (current === undefined) {
          certificate = await this.#repository.insertCertificate(tx, {
            id: certificateId,
            projectId,
            name,
            tags: options.tags ?? {},
          });
        } else {
          const locked = await this.#repository.lockCertificate(tx, current.id);
          if (locked === undefined || locked.deletedAt !== null) {
            throw new CertificateServiceError(
              404,
              "certificate_not_found",
              "Certificate not found",
            );
          }
          if ((await this.#repository.countVersions(tx, locked.id)) >= MAX_VERSIONS) {
            throw new CertificateServiceError(
              409,
              "certificate_version_limit",
              "Certificate version limit reached",
            );
          }
          certificate = locked;
        }
        const versionId = newUlid();
        const envelope = toStoredCertificateEnvelope(
          encryptValue(material.privateKeyBytes, this.#keyring, {
            objectType: "certificate",
            projectId,
            objectId: certificate.id,
            version: versionId,
          }),
        );
        const version = await this.#repository.insertVersion(tx, {
          id: versionId,
          certificateId: certificate.id,
          chainPem: material.certificateChainPem,
          envelope,
          subject: material.subject,
          sans: material.sans,
          issuer: material.issuer,
          serial: material.serial,
          fingerprint: material.fingerprint,
          notBefore: material.notBefore,
          notAfter: material.notAfter,
          createdBy: actorId,
        });
        await this.#repository.updateCurrentVersion(tx, certificate.id, versionId);
        await this.#repository.deleteSupersededNotifications(tx, certificate.id, versionId);
        let updated = certificate;
        if (current !== undefined && options.tags !== undefined) {
          const metadata = await this.#repository.updateMetadata(tx, certificate.id, {
            tags: options.tags,
            purgeProtected: certificate.purgeProtected,
          });
          if (metadata !== undefined) {
            updated = metadata;
          }
        }
        await this.#policy.recordDecision(decision, options.context, tx, {
          independent: false,
          details: {
            version: versionId,
            mode: options.mode,
            renewal: current === undefined ? 0 : 1,
          },
        });
        created = current === undefined;
        return { certificate: updated, version };
      });
      return {
        created,
        response: await this.#writeResponse(
          actorId,
          outcome.certificate,
          outcome.version,
          material.warnings,
        ),
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        await this.#recordError(
          actorId,
          decision,
          "certificate.write",
          projectId,
          certificateId,
          "certificate_name_conflict",
          options.context,
        );
        throw new CertificateServiceError(
          409,
          "certificate_name_conflict",
          "Certificate name conflict",
        );
      }
      if (error instanceof CertificateServiceError) {
        await this.#recordError(
          actorId,
          decision,
          "certificate.write",
          projectId,
          certificateId,
          error.code,
          options.context,
        );
        throw error;
      }
      if (error instanceof PolicyUnavailableError) {
        throw error;
      }
      throw new PolicyUnavailableError();
    }
  }

  /**
   * Reads one public certificate chain.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param name - Certificate name.
   * @param query - Optional version selector.
   * @param context - Optional request metadata.
   * @returns Metadata plus the public chain.
   */
  public async read(
    actorId: string,
    projectName: string,
    name: string,
    query: CertificateReadQuery,
    context?: PolicyAuditContext,
  ): Promise<CertificatePublicResponse> {
    const project = await this.#readProject(projectName);
    const certificate = await this.#activeCertificate(project.id, name);
    const decision = await this.#policy.authorize(
      actorId,
      "certificate.read",
      { type: "certificate", id: certificate.id, projectId: project.id },
      context,
      { audit: false },
    );
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw await this.#denyName(decision, project.id, context);
    }
    const version = await this.#selectedVersion(certificate, query);
    if (query.version === undefined && version.notAfter.getTime() <= this.#now()) {
      await this.#recordError(
        actorId,
        decision,
        "certificate.read",
        project.id,
        certificate.id,
        "certificate_expired",
        context,
        version.id,
      );
      throw new CertificateServiceError(410, "certificate_expired", "Certificate expired");
    }
    let chain: ReturnType<typeof splitChainPem>;
    try {
      chain = splitChainPem(version.chainPem);
    } catch {
      await this.#recordError(
        actorId,
        decision,
        "certificate.read",
        project.id,
        certificate.id,
        "certificate_integrity_failed",
        context,
        version.id,
      );
      throw new CertificateServiceError(
        500,
        "certificate_integrity_failed",
        "Certificate is unavailable",
      );
    }
    await this.#policy.recordDecision(decision, context, undefined, {
      details: { version: version.id },
    });
    const capabilities = await this.#capabilities(actorId, certificate);
    return {
      ...this.#metadata(certificate, version, capabilities),
      certificatePem: chain.certificatePem,
      chainPem: chain.chainPem,
    };
  }

  /**
   * Reads one certificate private key.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param name - Certificate name.
   * @param query - Optional version selector.
   * @param context - Optional request metadata.
   * @returns The private key and version identity.
   */
  public async readPrivate(
    actorId: string,
    projectName: string,
    name: string,
    query: CertificateReadQuery,
    context?: PolicyAuditContext,
  ): Promise<CertificatePrivateKeyResponse> {
    const project = await this.#readProject(projectName);
    const certificate = await this.#activeCertificate(project.id, name);
    const decision = await this.#policy.authorize(
      actorId,
      "certificate.read_private",
      { type: "certificate", id: certificate.id, projectId: project.id },
      context,
      { audit: false },
    );
    if (!decision.allowed) {
      const canRead = await this.#policy.authorize(
        actorId,
        "certificate.read",
        { type: "certificate", id: certificate.id, projectId: project.id },
        context,
        { audit: false },
      );
      await this.#policy.recordDecision(decision, context);
      throw await this.#denyName(decision, project.id, context, canRead.allowed);
    }
    const version = await this.#selectedVersion(certificate, query);
    if (query.version === undefined && version.notAfter.getTime() <= this.#now()) {
      await this.#recordError(
        actorId,
        decision,
        "certificate.read_private",
        project.id,
        certificate.id,
        "certificate_expired",
        context,
        version.id,
      );
      throw new CertificateServiceError(410, "certificate_expired", "Certificate expired");
    }
    let bytes: Buffer;
    try {
      bytes = decryptValue(
        fromStoredCertificateEnvelope(version),
        this.#keyring,
        {
          objectType: "certificate",
          projectId: project.id,
          objectId: certificate.id,
          version: version.id,
        },
        { maxCiphertextBytes: MAX_CERTIFICATE_CIPHERTEXT },
      );
    } catch (error) {
      await this.#recordError(
        actorId,
        decision,
        "certificate.read_private",
        project.id,
        certificate.id,
        "certificate_integrity_failed",
        context,
        version.id,
      );
      if (error instanceof KeyringError) {
        throw new CertificateServiceError(503, "service_unavailable", "Service unavailable");
      }
      throw new CertificateServiceError(
        500,
        "certificate_integrity_failed",
        "Certificate is unavailable",
      );
    }
    try {
      let privateKeyPem: string;
      try {
        const exported = createPrivateKey({
          key: bytes,
          format: "der",
          type: "pkcs8",
        }).export({ format: "pem", type: "pkcs8" });
        if (typeof exported !== "string") {
          throw new Error("Private key export failed");
        }
        privateKeyPem = exported;
      } catch {
        await this.#recordError(
          actorId,
          decision,
          "certificate.read_private",
          project.id,
          certificate.id,
          "certificate_integrity_failed",
          context,
          version.id,
        );
        throw new CertificateServiceError(
          500,
          "certificate_integrity_failed",
          "Certificate is unavailable",
        );
      }
      await this.#policy.recordDecision(decision, context, undefined, {
        details: { version: version.id },
      });
      const capabilities = await this.#capabilities(actorId, certificate);
      return {
        id: certificate.id,
        projectId: project.id,
        name: certificate.name,
        fingerprint: version.fingerprint,
        privateKeyPem,
        version: this.#version(version),
        capabilities,
      };
    } finally {
      bytes.fill(0);
    }
  }

  /**
   * Lists active certificates in one project.
   *
   * @param actorId - Authenticated principal.
   * @param projectName - Active project name.
   * @param query - Search and cursor filters.
   * @param context - Optional request metadata.
   * @returns One page and a continuation cursor.
   */
  public async list(
    actorId: string,
    projectName: string,
    query: CertificateListQuery,
    context?: PolicyAuditContext,
  ): Promise<CertificateList> {
    const project = await this.#activeProject(projectName, "project_not_found");
    const cursor = decodeCursor(query.cursor);
    const result = await this.#policy.authorizeList(
      actorId,
      "certificate.list",
      { type: "project", id: project.id },
      context,
    );
    if (!result.decision.allowed) {
      throw denialError("project_not_found", true, "Project not found");
    }
    const rows = await this.#repository.listActiveCertificates(this.#database, project.id, {
      q: query.q,
      san: query.san,
      expiresBefore: query.expiresBefore,
      expiresAfter: query.expiresAfter,
      cursor,
      limit: query.limit,
    });
    const page = rows.slice(0, query.limit);
    const resources = page.map((certificate) => ({
      type: "certificate" as const,
      id: certificate.id,
      projectId: project.id,
    }));
    const capabilities = await this.#policy.capabilitiesForMany(actorId, resources);
    const certificates = page.map((certificate) => {
      if (certificate.currentVersion === null) {
        throw new CertificateServiceError(
          500,
          "certificate_integrity_failed",
          "Certificate is unavailable",
        );
      }
      return this.#metadata(
        certificate,
        certificate.currentVersion,
        capabilities.get(certificate.id) ?? ZERO_CAPABILITIES,
      );
    });
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > query.limit && last !== undefined
        ? encodeCursor({ name: last.name, id: last.id })
        : null;
    return { certificates, nextCursor };
  }

  /**
   * Loads current metadata for one certificate.
   *
   * @param actorId - Authenticated principal.
   * @param certificateId - Certificate identifier.
   * @returns Public metadata.
   */
  public async metadataFor(actorId: string, certificateId: string): Promise<CertificateMetadata> {
    const certificate = await this.#repository.findCertificateById(this.#database, certificateId);
    if (certificate === undefined) {
      throw new CertificateServiceError(404, "certificate_not_found", "Certificate not found");
    }
    const version =
      certificate.currentVersionId === null
        ? undefined
        : await this.#repository.findVersionMetadata(
            this.#database,
            certificate.id,
            certificate.currentVersionId,
          );
    if (version === undefined) {
      throw new CertificateServiceError(
        500,
        "certificate_integrity_failed",
        "Certificate is unavailable",
      );
    }
    const capabilities = await this.#capabilities(actorId, certificate);
    return this.#metadata(certificate, version, capabilities);
  }

  /**
   * Resolves an active project by name.
   *
   * The list route keeps `project_not_found`. Name-addressed routes use
   * `certificate_not_found` so a caller cannot tell a missing project from a
   * missing certificate.
   */
  async #activeProject(
    name: string,
    notFoundCode: "project_not_found" | "certificate_not_found" = "certificate_not_found",
  ) {
    if (!projectNameSchema.safeParse(name).success) {
      throw new CertificateServiceError(
        404,
        notFoundCode,
        notFoundCode === "project_not_found" ? "Project not found" : "Resource not found",
      );
    }
    const project = await this.#projectRepository.findActiveByName(this.#database, name);
    if (project === undefined) {
      throw new CertificateServiceError(
        404,
        notFoundCode,
        notFoundCode === "project_not_found" ? "Project not found" : "Resource not found",
      );
    }
    return project;
  }

  /** Resolves an active certificate by name. */
  async #activeCertificate(projectId: string, name: string): Promise<CertificateRecord> {
    if (!certificateNameSchema.safeParse(name).success) {
      throw new CertificateServiceError(404, "certificate_not_found", "Resource not found");
    }
    const certificate = await this.#repository.findCertificateByName(
      this.#database,
      projectId,
      name,
    );
    if (certificate === undefined || certificate.deletedAt !== null) {
      throw new CertificateServiceError(404, "certificate_not_found", "Resource not found");
    }
    return certificate;
  }

  /** Resolves a selected version or the current version. */
  async #selectedVersion(
    certificate: CertificateRecord,
    query: CertificateReadQuery,
  ): Promise<CertificateVersionRecord> {
    const versionId = query.version ?? certificate.currentVersionId;
    if (versionId === null) {
      throw new CertificateServiceError(404, "certificate_version_not_found", "Version not found");
    }
    const version = await this.#repository.findVersion(this.#database, certificate.id, versionId);
    if (version === undefined) {
      throw new CertificateServiceError(404, "certificate_version_not_found", "Version not found");
    }
    return version;
  }

  /** Pre-authorizes one write action at project scope before any parsing or key work. */
  async #preAuthorizeProject(
    actorId: string,
    action: "certificate.write",
    projectId: string,
    context?: PolicyAuditContext,
  ): Promise<PolicyDecision> {
    const decision = await this.#policy.authorize(
      actorId,
      action,
      { type: "project", id: projectId },
      context,
      { audit: false },
    );
    if (!decision.allowed) {
      await this.#policy.recordDecision(decision, context);
      throw await this.#denyName(decision, projectId, context);
    }
    return decision;
  }

  /**
   * Chooses the public denial for a name-addressed certificate route.
   *
   * A caller that can list certificates, or can already read the selected
   * certificate, knows the name exists and receives 403. Every other caller
   * receives the same 404 as a missing name.
   */
  async #denyName(
    decision: PolicyDecision,
    projectId: string,
    context?: PolicyAuditContext,
    canReadObject = false,
  ): Promise<CertificateServiceError> {
    const canList = await canListCollection({
      policy: this.#policy,
      actorId: decision.actorId,
      listAction: "certificate.list",
      projectId,
      ...(context === undefined ? {} : { context }),
    });
    return denialError("certificate_not_found", !(canList || canReadObject));
  }

  /** Resolves a project for a read path, mapping missing/inaccessible to the data-plane 404. */
  async #readProject(name: string) {
    try {
      return await this.#activeProject(name);
    } catch (error) {
      if (error instanceof CertificateServiceError) {
        throw new CertificateServiceError(404, "certificate_not_found", "Resource not found");
      }
      throw error;
    }
  }

  /** Builds metadata for one selected version. */
  #metadata(
    certificate: CertificateRecord,
    version: CertificateVersionMetadata,
    capabilities: CapabilityFlags,
  ): CertificateMetadata {
    return {
      id: certificate.id,
      projectId: certificate.projectId,
      name: certificate.name,
      tags: certificate.tags,
      status:
        certificate.deletedAt !== null
          ? "deleted"
          : version.notAfter.getTime() <= this.#now()
            ? "expired"
            : "active",
      subject: version.subject,
      sans: [...version.sans],
      issuer: version.issuer,
      serial: version.serial,
      fingerprint: version.fingerprint,
      notBefore: version.notBefore.toISOString(),
      notAfter: version.notAfter.toISOString(),
      daysToExpiry: Math.ceil((version.notAfter.getTime() - this.#now()) / DAY_MS),
      chainLength: version.chainLength,
      version: this.#version(version),
      createdAt: certificate.createdAt.toISOString(),
      updatedAt: certificate.updatedAt.toISOString(),
      deletedAt: certificate.deletedAt?.toISOString() ?? null,
      purgeAfter: certificate.purgeAfter?.toISOString() ?? null,
      purgeProtected: certificate.purgeProtected,
      capabilities,
    };
  }

  /** Maps one version identity. */
  #version(version: {
    readonly id: string;
    readonly createdAt: Date;
    readonly createdBy: string;
    readonly notBefore: Date;
    readonly notAfter: Date;
    readonly fingerprint: string;
    readonly serial: string;
  }): CertificateVersion {
    return {
      id: version.id,
      createdAt: version.createdAt.toISOString(),
      createdBy: version.createdBy,
      notBefore: version.notBefore.toISOString(),
      notAfter: version.notAfter.toISOString(),
      fingerprint: version.fingerprint,
      serial: version.serial,
    };
  }

  /** Computes the five certificate flags for one certificate. */
  async #capabilities(actorId: string, certificate: CertificateRecord): Promise<CapabilityFlags> {
    const result = await this.#policy.capabilitiesForMany(actorId, [
      { type: "certificate", id: certificate.id, projectId: certificate.projectId },
    ]);
    return result.get(certificate.id) ?? ZERO_CAPABILITIES;
  }

  /** Builds the write response with the public material. */
  async #writeResponse(
    actorId: string,
    certificate: CertificateRecord,
    version: CertificateVersionRecord,
    warnings: ParsedCertificateMaterial["warnings"],
  ): Promise<CertificateWriteResponse> {
    let chain: ReturnType<typeof splitChainPem>;
    try {
      chain = splitChainPem(version.chainPem);
    } catch {
      throw new CertificateServiceError(
        500,
        "certificate_integrity_failed",
        "Certificate is unavailable",
      );
    }
    const capabilities = await this.#capabilities(actorId, certificate);
    return {
      ...this.#metadata(certificate, version, capabilities),
      certificatePem: chain.certificatePem,
      chainPem: chain.chainPem,
      warnings: [...warnings],
    };
  }

  /** Writes one independent error outcome for a failed state change. */
  async #recordError(
    actorId: string,
    decision: PolicyDecision,
    action: (typeof CERTIFICATE_ACTIONS)[number],
    projectId: string,
    certificateId: string,
    reason: string,
    context?: PolicyAuditContext,
    versionId?: string,
  ): Promise<void> {
    try {
      await this.#audit.record({
        eventId: newUlid(),
        ts: new Date(this.#now()),
        projectId,
        requestId: context?.requestId ?? "internal",
        actorId,
        actorKind: decision.actorKind,
        action,
        scopeType: "project",
        scopeId: projectId,
        objectType: "certificate",
        objectId: certificateId,
        result: "error",
        sourceIp: context?.sourceIp ?? null,
        userAgent: context?.userAgent ?? null,
        details: {
          reason,
          policyVersion: decision.policyVersion,
          ...(versionId === undefined ? {} : { version: versionId }),
        },
      });
    } catch {
      throw new PolicyUnavailableError();
    }
  }
}
