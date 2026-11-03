import { createHash, X509Certificate } from "node:crypto";
import type { TLSSocket } from "node:tls";
import type { Request } from "express";
import type { QueryExecutor } from "../identity/identity-repository.js";
import { canonicalPublicKeyHash } from "../security/x509.js";
import { listenerOf } from "../transport/scope.js";
import type { AgentAuthContext } from "./types.js";

/** Positive-cache lifetime for one authenticated certificate. */
const CACHE_TTL_MS = 5_000;
/** Maximum positive entries held by one process. */
const CACHE_LIMIT = 1_024;

interface CacheEntry {
  readonly expiresAt: number;
  readonly context: AgentAuthContext;
}

interface AgentRow {
  readonly id: string;
  readonly serial: string;
  readonly fingerprint: string;
  readonly not_after: Date;
  readonly principal_id: string;
  readonly owner_project_id: string;
  readonly principal_status: string;
  readonly project_name: string;
  readonly deleted_at: Date | null;
}

/** Authenticator contract used by the middleware and test seams. */
export interface AgentAuthenticator {
  /** Resolves and caches the context for one request. */
  authenticate(req: Request): Promise<AgentAuthContext | undefined>;
  /** Resolves the context without reading the positive cache. */
  revalidate(req: Request): Promise<AgentAuthContext | undefined>;
  /** Removes every cached entry for a principal. */
  invalidatePrincipal(principalId: string): void;
}

/** Returns true when a value exposes the TLS peer-certificate interface. */
function isTlsSocket(value: unknown): value is TLSSocket {
  return (
    typeof value === "object" &&
    value !== null &&
    "getPeerCertificate" in value &&
    "authorized" in value
  );
}

/** Computes lowercase SHA-256 hex. */
function sha256Hex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Database-backed agent authenticator with a bounded five-second cache.
 *
 * A request is accepted only after the TLS chain is authorized, the peer
 * certificate matches a live `workload_certs` row, the principal is active,
 * and the owner project is not soft-deleted. Misses are never cached, so a
 * newly joined agent is accepted immediately.
 */
export class DatabaseAgentAuthenticator implements AgentAuthenticator {
  readonly #database: QueryExecutor;
  readonly #now: () => number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #limit: number;

  /**
   * @param options - Database, injectable clock, and optional cache bound.
   */
  public constructor(options: {
    readonly database: QueryExecutor;
    readonly now?: () => number;
    readonly limit?: number;
  }) {
    this.#database = options.database;
    this.#now = options.now ?? Date.now;
    this.#limit = options.limit ?? CACHE_LIMIT;
  }

  /** @inheritDoc */
  public async authenticate(req: Request): Promise<AgentAuthContext | undefined> {
    return this.#resolve(req, true);
  }

  /** @inheritDoc */
  public async revalidate(req: Request): Promise<AgentAuthContext | undefined> {
    return this.#resolve(req, false);
  }

  /** @inheritDoc */
  public invalidatePrincipal(principalId: string): void {
    for (const [fingerprint, entry] of this.#cache) {
      if (entry.context.principalId === principalId) {
        this.#cache.delete(fingerprint);
      }
    }
  }

  /** Removes every cached entry. */
  public clear(): void {
    this.#cache.clear();
  }

  /** Current number of retained entries after pruning. */
  public get size(): number {
    this.#prune();
    return this.#cache.size;
  }

  async #resolve(req: Request, useCache: boolean): Promise<AgentAuthContext | undefined> {
    if (listenerOf(req) !== "agent") {
      return undefined;
    }
    if (!isTlsSocket(req.socket) || req.socket.authorized !== true) {
      return undefined;
    }

    const peer = req.socket.getPeerCertificate();
    const raw = peer.raw;
    if (!Buffer.isBuffer(raw) || raw.length === 0) {
      return undefined;
    }

    const fingerprint = sha256Hex(raw);
    if (useCache) {
      this.#prune();
      const cached = this.#cache.get(fingerprint);
      if (cached !== undefined) {
        if (cached.context.notAfter > this.#now()) {
          return cached.context;
        }
        this.#cache.delete(fingerprint);
      }
    }

    const readStartedAt = this.#now();
    const result = await this.#database.executeQuery<AgentRow>(
      `SELECT wc.id, wc.serial, wc.fingerprint, wc.not_after,
              p.id AS principal_id, p.owner_project_id, p.status AS principal_status,
              pr.name AS project_name, pr.deleted_at
         FROM workload_certs wc
         JOIN principals p ON p.id = wc.principal_id
         JOIN projects pr ON pr.id = p.owner_project_id
        WHERE wc.fingerprint = :fingerprint
          AND wc.revoked_at IS NULL
          AND wc.not_before <= now()
          AND wc.not_after > now()
          AND p.status = 'active'
          AND pr.deleted_at IS NULL`,
      { fingerprint },
    );
    if (this.#now() - readStartedAt >= CACHE_TTL_MS) {
      // A slow database read must not admit a request whose snapshot is older
      // than the admission guarantee, even though the cache entry is expired.
      return undefined;
    }

    const row = result.records[0];
    if (row === undefined || row.not_after.getTime() <= this.#now()) {
      return undefined;
    }

    let publicKeySha256: string | undefined;
    try {
      const certificate = new X509Certificate(raw);
      publicKeySha256 = canonicalPublicKeyHash(
        Buffer.from(certificate.publicKey.export({ type: "spki", format: "der" })),
      );
    } catch {
      return undefined;
    }
    if (publicKeySha256 === undefined) {
      return undefined;
    }

    const context: AgentAuthContext = {
      kind: "agent",
      principalId: row.principal_id,
      projectId: row.owner_project_id,
      projectName: row.project_name,
      certificateId: row.id,
      serial: row.serial,
      fingerprint,
      publicKeySha256,
      notAfter: row.not_after.getTime(),
    };
    this.#cache.set(fingerprint, { expiresAt: readStartedAt + CACHE_TTL_MS, context });
    this.#enforceBound();
    return context;
  }

  /** Removes expired entries. */
  #prune(): void {
    const now = this.#now();
    for (const [key, entry] of this.#cache) {
      if (entry.expiresAt <= now) {
        this.#cache.delete(key);
      }
    }
  }

  /** Keeps the cache bounded by dropping the oldest insertion. */
  #enforceBound(): void {
    while (this.#cache.size > this.#limit) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.#cache.delete(oldest);
    }
  }
}
