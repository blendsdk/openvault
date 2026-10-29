/**
 * The allowed shape of a project name.
 *
 * Project names are lowercase and may contain digits and internal hyphens. They must start
 * and end with an alphanumeric character, and they are between 3 and 40 characters long.
 * Requiring alphanumeric ends keeps names safe to use in paths, DNS labels, and Compose
 * identifiers without an extra escaping step.
 *
 * @example
 * ```ts
 * PROJECT_NAME_PATTERN.test("payments-api"); // true
 * PROJECT_NAME_PATTERN.test("payments-");    // false
 * ```
 */
export const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/**
 * The allowed shape of a secret name.
 *
 * Secret names are case-sensitive, may contain digits and internal hyphens, and are between
 * 1 and 127 characters long. The first character must be alphanumeric. Path separators,
 * traversal text, and control characters are rejected so a name can never escape the
 * per-secret delivery path.
 *
 * @example
 * ```ts
 * SECRET_NAME_PATTERN.test("database-password"); // true
 * SECRET_NAME_PATTERN.test("../database-password"); // false
 * ```
 */
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,126}$/;
