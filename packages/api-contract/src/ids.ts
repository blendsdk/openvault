import { PROJECT_NAME_PATTERN, SECRET_NAME_PATTERN, ULID_PATTERN } from "@openvault/core";
import { z } from "zod";

/**
 * Validates the canonical 26-character ULID form used by API resource identifiers.
 *
 * @example
 * ```ts
 * ulidSchema.parse("01ARZ3NDEKTSV4RRFFQ69G5FAV");
 * ```
 */
export const ulidSchema = z.string().regex(ULID_PATTERN, "Invalid ULID");

/**
 * Validates a project name.
 *
 * Project names are lowercase, 3-40 characters long, and must start and end with an
 * alphanumeric character. Internal hyphens are allowed.
 *
 * @example
 * ```ts
 * projectNameSchema.parse("payments-api");
 * ```
 */
export const projectNameSchema = z.string().regex(PROJECT_NAME_PATTERN, "Invalid project name");

/**
 * Validates a secret name.
 *
 * Secret names are 1-127 characters long, start with an alphanumeric character, and may
 * contain internal hyphens. Path separators and control characters are rejected.
 *
 * @example
 * ```ts
 * secretNameSchema.parse("database-password");
 * ```
 */
export const secretNameSchema = z.string().regex(SECRET_NAME_PATTERN, "Invalid secret name");
