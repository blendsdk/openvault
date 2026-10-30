import { z } from "zod";
import { ulidSchema } from "./ids.js";

/**
 * Authentication methods a browser session can use.
 *
 * `local` is a password login; `oidc` is an authorization-code login through
 * the configured identity provider.
 */
export const authMethodSchema = z.enum(["local", "oidc"]);

/**
 * Public user fields returned by the auth endpoints.
 *
 * The shape is deliberately minimal: internal status, credential state, and
 * role assignments are not exposed to the browser.
 */
export const authUserSchema = z.strictObject({
  id: ulidSchema,
  name: z.string().min(1).max(100),
  email: z.string().email().max(320).nullable(),
  authMethod: authMethodSchema,
});

/**
 * Local login request.
 *
 * The identifier is trimmed for validation; the controller lowercases it
 * before the database lookup. Passwords are never trimmed.
 */
export const loginRequestSchema = z.strictObject({
  identifier: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1024),
});

/**
 * Password-change request for a signed-in user.
 *
 * The current password is required even during a forced change. The new
 * password must be 12–1024 characters; no composition rules are applied.
 */
export const passwordChangeRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(12).max(1024),
});

/**
 * Login and `/me` response.
 *
 * `lastLoginAt` is the creation time of the current session. `csrfToken` is the
 * per-session token the browser sends in `X-CSRF-Token` on unsafe requests.
 */
export const sessionResponseSchema = z.strictObject({
  user: authUserSchema,
  expiresAt: z.iso.datetime(),
  csrfToken: z.string().min(32),
  mustChangePassword: z.boolean(),
  lastLoginAt: z.iso.datetime(),
});

/**
 * Refresh response. The browser receives the rotated CSRF token and expiry.
 */
export const refreshResponseSchema = z.strictObject({
  expiresAt: z.iso.datetime(),
  csrfToken: z.string().min(32),
});

/**
 * One entry in the current principal's session list.
 *
 * `id` is the public session identifier, not the secret cookie value.
 */
export const sessionEntrySchema = z.strictObject({
  id: ulidSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  authMethod: authMethodSchema,
  current: z.boolean(),
});

/** The current principal's sessions, newest first. */
export const sessionListSchema = z.strictObject({
  sessions: z.array(sessionEntrySchema),
});

/** Capability flags for the login page. */
export const metaAuthSchema = z.strictObject({
  local: z.boolean(),
  oidc: z.boolean(),
});

/** Inferred login request type. */
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Inferred password-change request type. */
export type PasswordChangeRequest = z.infer<typeof passwordChangeRequestSchema>;

/** Inferred public user type. */
export type AuthUser = z.infer<typeof authUserSchema>;

/** Inferred login and `/me` response type. */
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** Inferred refresh response type. */
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

/** Inferred session-list entry type. */
export type SessionEntry = z.infer<typeof sessionEntrySchema>;

/** Inferred session-list response type. */
export type SessionList = z.infer<typeof sessionListSchema>;

/** Inferred authentication capability type. */
export type MetaAuth = z.infer<typeof metaAuthSchema>;
