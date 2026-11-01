import type { AuthMethod, AuthUser } from "@openvault/api-contract";
import type { CacheProvider } from "blendsdk/webafx-cache";

export type { AuthMethod, AuthUser };

/** Test-only collaboration seams for the auth plugin. */
export interface AuthOverrides {
  /** Fetch implementation used by the OIDC client (for a trusted test IdP). */
  readonly fetch?: typeof globalThis.fetch;
  /** Cache shared by sessions and OIDC state (for recording tests). */
  readonly cache?: CacheProvider;
  /** Injectable clock for session and OIDC state timing. */
  readonly now?: () => number;
  /** Session index sweeper interval; `0` disables it. */
  readonly sweepIntervalMs?: number;
}

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
 * Authenticated browser request context.
 *
 * The user shape is the public contract shared with the web client; internal
 * status and credential fields never enter this object. CSRF and Origin checks
 * apply only to this variant.
 */
export interface BrowserAuthContext {
  /** Discriminator used by guards and route helpers. */
  readonly kind: "browser";
  /** The live browser session. */
  readonly session: SessionRecord;
  /** Public user fields for the current principal. */
  readonly user: AuthUser;
  /** True while the principal must change a local password. */
  readonly mustChangePassword: boolean;
}

/**
 * Authenticated CLI request context.
 *
 * `familyId` is the JWT `sid`; every request rechecks a live family row so a
 * logout, password change, or reuse detection takes effect on the next call.
 * Browser CSRF and Origin checks never apply to this variant.
 */
export interface CliAuthContext {
  /** Discriminator used by guards and route helpers. */
  readonly kind: "cli";
  /** Principal identifier from the JWT `sub`. */
  readonly principalId: string;
  /** CLI session family identifier from the JWT `sid`. */
  readonly familyId: string;
  /** Access-token identifier. */
  readonly jti: string;
  /** Access-token expiry in milliseconds since the Unix epoch. */
  readonly expiresAt: number;
  /** Public user fields loaded from the database. */
  readonly user: AuthUser;
  /** True while the principal must change a local password. */
  readonly mustChangePassword: boolean;
}

/** Authenticated request context attached by the middleware. */
export type AuthContext = BrowserAuthContext | CliAuthContext;

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
