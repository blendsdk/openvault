import { z } from "zod";
import { authUserSchema, loginRequestSchema } from "./auth.js";
import { ulidSchema } from "./ids.js";

/**
 * The CLI login request.
 *
 * The shape is the same as browser local login: an identifier with
 * surrounding whitespace trimmed and a password that is never trimmed. The
 * shared schema keeps both login surfaces on the same bounds.
 *
 * @example
 * ```ts
 * cliLoginRequestSchema.parse({
 *   identifier: "alice@example.com",
 *   password: "correct horse battery staple",
 * });
 * ```
 */
export const cliLoginRequestSchema = loginRequestSchema;

/**
 * A CLI refresh token.
 *
 * The token is 32 random bytes encoded as 43 unpadded base64url characters.
 * It is opaque to clients and is never a JWT.
 *
 * @example
 * ```ts
 * cliRefreshTokenSchema.parse("A".repeat(43));
 * ```
 */
export const cliRefreshTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * The response returned by CLI login and refresh.
 *
 * `accessExpiresAt` and `refreshExpiresAt` are deliberately separate fields:
 * the access token is short-lived, while the refresh family has an absolute
 * lifetime from login. `user` is the same public shape used by the browser.
 *
 * @example
 * ```ts
 * cliTokenResponseSchema.parse({
 *   accessToken: "header.payload.signature",
 *   refreshToken: "A".repeat(43),
 *   tokenType: "Bearer",
 *   accessExpiresAt: "2026-10-30T12:15:00.000Z",
 *   refreshExpiresAt: "2026-10-31T00:00:00.000Z",
 *   user: {
 *     id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
 *     name: "Alice",
 *     email: "alice@example.com",
 *     authMethod: "local",
 *   },
 *   mustChangePassword: false,
 * });
 * ```
 */
export const cliTokenResponseSchema = z.strictObject({
  accessToken: z.string().min(1),
  refreshToken: cliRefreshTokenSchema,
  tokenType: z.literal("Bearer"),
  accessExpiresAt: z.iso.datetime(),
  refreshExpiresAt: z.iso.datetime(),
  user: authUserSchema,
  mustChangePassword: z.boolean(),
});

/**
 * The CLI refresh request.
 *
 * Unknown fields are rejected so a caller cannot smuggle an access token or a
 * future parameter into the rotation path.
 */
export const cliRefreshRequestSchema = z.strictObject({
  refreshToken: cliRefreshTokenSchema,
});

/**
 * The CLI logout request.
 *
 * Logout authorizes on possession of the refresh token and is idempotent for
 * any well-formed token.
 */
export const cliLogoutRequestSchema = z.strictObject({
  refreshToken: cliRefreshTokenSchema,
});

/**
 * The response returned by `GET /v1/auth/cli/me`.
 *
 * The user object is the public contract; it never contains a token, hash, or
 * internal row identifier.
 */
export const cliMeResponseSchema = z.strictObject({
  user: authUserSchema,
  mustChangePassword: z.boolean(),
});

/**
 * One CLI session family in the caller's list.
 *
 * `id` is the public family identifier used by the JWT `sid` and the revoke
 * route. `createdAt` is the family's original login time, not the time of the
 * latest rotation.
 */
export const cliSessionEntrySchema = z.strictObject({
  id: ulidSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  current: z.boolean(),
});

/**
 * The current principal's live CLI session families, newest first.
 */
export const cliSessionListSchema = z.strictObject({
  sessions: z.array(cliSessionEntrySchema),
});

/** Inferred CLI login request type. */
export type CliLoginRequest = z.infer<typeof cliLoginRequestSchema>;

/** Inferred CLI login and refresh response type. */
export type CliTokenResponse = z.infer<typeof cliTokenResponseSchema>;

/** Inferred CLI refresh request type. */
export type CliRefreshRequest = z.infer<typeof cliRefreshRequestSchema>;

/** Inferred CLI logout request type. */
export type CliLogoutRequest = z.infer<typeof cliLogoutRequestSchema>;

/** Inferred CLI `/me` response type. */
export type CliMeResponse = z.infer<typeof cliMeResponseSchema>;

/** Inferred CLI session entry type. */
export type CliSessionEntry = z.infer<typeof cliSessionEntrySchema>;

/** Inferred CLI session list type. */
export type CliSessionList = z.infer<typeof cliSessionListSchema>;
