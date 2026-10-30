import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import { OidcAccessDeniedError, OidcLinkCollisionError } from "./errors.js";

const MAX_ISSUER_LENGTH = 255;
const MAX_SUBJECT_LENGTH = 255;
const MAX_EMAIL_LENGTH = 320;
const MAX_NAME_LENGTH = 100;

/** Input to {@link OidcIdentityService.resolve}. */
export interface OidcIdentityInput {
  /** OIDC issuer URL. */
  readonly issuer: string;
  /** Verified ID-token subject. */
  readonly subject: string;
  /** Verified ID-token claims. */
  readonly claims: Record<string, unknown>;
  /** UserInfo claims. */
  readonly userInfo: Record<string, unknown>;
  /** Allowed email domains; empty disables JIT provisioning. */
  readonly allowedDomains: readonly string[];
}

/** A linked or provisioned principal. */
export interface OidcIdentity {
  /** Principal identifier. */
  readonly principalId: string;
  /** Display name. */
  readonly name: string;
  /** Normalized email. */
  readonly email: string;
}

interface IdentityRow {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly status: string;
}

function hasLength(value: string, minimum: number, maximum: number): boolean {
  return value.length >= minimum && value.length <= maximum;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "23505";
}

function normalizedName(value: unknown, email: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().slice(0, MAX_NAME_LENGTH);
  }
  const localPart = email.slice(0, email.lastIndexOf("@"));
  return (localPart.length > 0 ? localPart : "OIDC User").slice(0, MAX_NAME_LENGTH);
}

/**
 * Links an OIDC identity to a principal or provisions one under the JIT rules.
 *
 * Identity is the `(issuer, subject)` pair. JIT requires an explicitly
 * verified email, an unused normalized email, and an exact allowed-domain
 * match. A verified email that already belongs to another principal is never
 * auto-linked; it produces a collision that an administrator must resolve.
 */
export class OidcIdentityService {
  readonly #database: PostgreSQLDatabase;

  /**
   * @param options - Connected database used for identity reads and JIT writes.
   */
  public constructor(options: { readonly database: PostgreSQLDatabase }) {
    this.#database = options.database;
  }

  /**
   * Resolves the principal for a verified OIDC identity.
   *
   * @param input - Verified issuer, subject, claims, and JIT policy.
   * @returns The linked or provisioned principal.
   * @throws {OidcAccessDeniedError} When the principal is disabled or JIT is denied.
   * @throws {OidcLinkCollisionError} When the email belongs to another principal.
   */
  public async resolve(input: OidcIdentityInput): Promise<OidcIdentity> {
    if (
      !hasLength(input.issuer, 1, MAX_ISSUER_LENGTH) ||
      !hasLength(input.subject, 1, MAX_SUBJECT_LENGTH)
    ) {
      throw new OidcAccessDeniedError();
    }

    const existing = await this.#findIdentity(input.issuer, input.subject);
    if (existing !== undefined) {
      if (existing.status !== "active") {
        throw new OidcAccessDeniedError();
      }
      return {
        principalId: existing.id,
        name: existing.name,
        email: existing.email ?? "",
      };
    }

    if (input.allowedDomains.length === 0) {
      throw new OidcAccessDeniedError();
    }

    const merged = { ...input.claims, ...input.userInfo };
    const emailValue = merged.email;
    if (merged.email_verified !== true || typeof emailValue !== "string") {
      throw new OidcAccessDeniedError();
    }

    const email = emailValue.trim().toLowerCase();
    const at = email.lastIndexOf("@");
    if (at <= 0 || !hasLength(email, 3, MAX_EMAIL_LENGTH)) {
      throw new OidcAccessDeniedError();
    }
    const domain = email.slice(at + 1);
    if (!input.allowedDomains.some((allowed) => allowed.toLowerCase() === domain)) {
      throw new OidcAccessDeniedError();
    }

    const name = normalizedName(merged.name, email);
    const principalId = newUlid();

    try {
      await this.#database.withTransaction(async (tx) => {
        const collision = await tx.executeQuery<{ readonly id: string }>(
          `SELECT id FROM principals WHERE kind = 'user' AND lower(email) = :email`,
          { email },
        );
        if (collision.records[0] !== undefined) {
          throw new OidcLinkCollisionError();
        }

        await tx.executeQuery(
          `INSERT INTO principals (id, kind, name, email, status)
           VALUES (:principalId, 'user', :name, :email, 'active')`,
          { principalId, name, email },
        );
        await tx.executeQuery(
          `INSERT INTO oidc_identities (principal_id, issuer, subject)
           VALUES (:principalId, :issuer, :subject)`,
          { principalId, issuer: input.issuer, subject: input.subject },
        );
      });
    } catch (error) {
      if (error instanceof OidcLinkCollisionError) {
        throw error;
      }
      if (isUniqueViolation(error)) {
        const raced = await this.#findIdentity(input.issuer, input.subject);
        if (raced !== undefined) {
          if (raced.status !== "active") {
            throw new OidcAccessDeniedError();
          }
          return {
            principalId: raced.id,
            name: raced.name,
            email: raced.email ?? email,
          };
        }
        throw new OidcLinkCollisionError();
      }
      throw error;
    }

    return { principalId, name, email };
  }

  async #findIdentity(issuer: string, subject: string): Promise<IdentityRow | undefined> {
    const result = await this.#database.executeQuery<IdentityRow>(
      `SELECT p.id, p.name, p.email, p.status
         FROM oidc_identities i
         JOIN principals p ON p.id = i.principal_id
        WHERE i.issuer = :issuer AND i.subject = :subject`,
      { issuer, subject },
    );
    return result.records[0];
  }
}
