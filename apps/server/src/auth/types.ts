import type { AuthMethod, AuthUser } from "@openvault/api-contract";

export type { AuthMethod, AuthUser };

/**
 * A browser session stored in the memory cache.
 *
 * The record deliberately contains no OIDC token and no session secret. The
 * secret cookie value is the cache key input; only its SHA-256 hash is used as
 * the key.
 */
export interface SessionRecord {
  /** Stable public identifier used by the session list and revoke routes. */
  readonly publicId: string;
  /** Principal that owns the session. */
  readonly principalId: string;
  /** Per-session CSRF token returned by `/v1/auth/me`. */
  readonly csrfToken: string;
  /** Creation time in milliseconds since the Unix epoch. */
  readonly createdAt: number;
  /** Absolute expiry in milliseconds since the Unix epoch. */
  readonly expiresAt: number;
  /** Authentication method that created the session. */
  readonly authMethod: AuthMethod;
}

/**
 * Authenticated request context attached by the session middleware.
 *
 * The user shape is the public contract shared with the web client; internal
 * status and credential fields never enter this object.
 */
export interface AuthContext {
  /** The live session record. */
  readonly session: SessionRecord;
  /** Public user fields for the current principal. */
  readonly user: AuthUser;
  /** True while the principal must change a local password. */
  readonly mustChangePassword: boolean;
}

/** Principal status returned by the credentials repository. */
export interface PrincipalStatus {
  /** Whether the principal may authenticate. */
  readonly status: "active" | "disabled";
  /** Display name. */
  readonly name: string;
  /** Email address, or null when the principal has none. */
  readonly email: string | null;
  /** True when a local password must be changed before other actions. */
  readonly mustChange: boolean;
}
