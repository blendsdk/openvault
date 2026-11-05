/**
 * The closed action catalogs.
 *
 * This module has no schema dependency so browser clients can use the action
 * names without pulling the Zod contract into their bundle.
 *
 * @module
 */

/**
 * The 25 fixed authorization actions.
 *
 * The order is the public catalog order. Control-plane actions come first so
 * the catalog can expose the plane without a second lookup table.
 *
 * @example
 * ```ts
 * RBAC_ACTIONS.includes("secret.read");
 * ```
 */
export const RBAC_ACTIONS = [
  "project.create",
  "project.read",
  "project.update",
  "project.delete",
  "identity.create",
  "identity.read",
  "identity.revoke",
  "identity.join_token",
  "assignment.read",
  "assignment.write",
  "audit.read",
  "kek.rotate",
  "secret.list",
  "secret.read",
  "secret.write",
  "secret.delete",
  "secret.recover",
  "secret.purge",
  "certificate.list",
  "certificate.read",
  "certificate.read_private",
  "certificate.write",
  "certificate.delete",
  "certificate.recover",
  "certificate.purge",
] as const;

/** One fixed authorization action. */
export type RbacAction = (typeof RBAC_ACTIONS)[number];

/** Actions that are not part of the fixed authorization action catalog. */
export const BUSINESS_AUDIT_ACTIONS = [
  "auth.login",
  "auth.lockout",
  "assignment.grant",
  "assignment.revoke",
  "agent.join",
  "agent.renew",
  "consumer.register",
  "consumer.update",
  "audit.verify",
  "audit.export",
  "audit.prune",
  "backup.create",
  "backup.restore",
  "certificate.expiry_warning",
] as const;

/**
 * Every authorization action plus the business audit actions.
 *
 * Query filters and the writer share this closed catalog so an event cannot be
 * recorded under a name that the API cannot filter.
 *
 * @example
 * ```ts
 * AUDIT_ACTIONS.includes("identity.create");
 * ```
 */
export const AUDIT_ACTIONS = [...RBAC_ACTIONS, ...BUSINESS_AUDIT_ACTIONS] as const;

/** One action accepted by the audit API and writer. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
