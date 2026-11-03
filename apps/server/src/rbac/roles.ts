import {
  RBAC_ROLES,
  type RbacAction,
  type RbacRole,
  type RbacScopeType,
} from "@openvault/api-contract";

export { RBAC_ROLES, type RbacRole };

/** One role's actions and the scopes where it may be assigned. */
export interface RoleDefinition {
  /** Fixed actions granted by the role. */
  readonly actions: readonly RbacAction[];
  /** Scopes where the role is eligible. */
  readonly scopes: readonly RbacScopeType[];
}

/**
 * The single role matrix used by the evaluator, grant guards, and tests.
 *
 * The rows match the published role reference exactly. Object scope appears
 * only for the two reader roles, matching the database constraint.
 */
export const ROLE_DEFINITIONS: ReadonlyMap<RbacRole, RoleDefinition> = new Map<
  RbacRole,
  RoleDefinition
>([
  [
    "org.admin",
    {
      actions: [
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
      ],
      scopes: ["org"],
    },
  ],
  [
    "project.admin",
    {
      actions: [
        "project.read",
        "project.update",
        "identity.create",
        "identity.read",
        "identity.revoke",
        "identity.join_token",
        "assignment.read",
        "assignment.write",
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
      ],
      scopes: ["org", "project"],
    },
  ],
  [
    "secrets.manager",
    {
      actions: [
        "secret.list",
        "secret.read",
        "secret.write",
        "secret.delete",
        "secret.recover",
        "secret.purge",
      ],
      scopes: ["org", "project"],
    },
  ],
  [
    "secrets.officer",
    {
      actions: ["secret.list", "secret.read", "secret.write", "secret.delete", "secret.recover"],
      scopes: ["org", "project"],
    },
  ],
  [
    "secrets.reader",
    {
      actions: ["secret.list", "secret.read"],
      scopes: ["org", "project", "object"],
    },
  ],
  [
    "certificates.officer",
    {
      actions: [
        "certificate.list",
        "certificate.read",
        "certificate.read_private",
        "certificate.write",
        "certificate.delete",
        "certificate.recover",
      ],
      scopes: ["org", "project"],
    },
  ],
  [
    "certificates.reader",
    {
      actions: ["certificate.list", "certificate.read"],
      scopes: ["org", "project", "object"],
    },
  ],
  [
    "auditor",
    {
      actions: [
        "project.read",
        "identity.read",
        "assignment.read",
        "audit.read",
        "secret.list",
        "certificate.list",
      ],
      scopes: ["org", "project"],
    },
  ],
  [
    "reader",
    {
      actions: ["project.read", "secret.list", "certificate.list"],
      scopes: ["org", "project"],
    },
  ],
]);

/**
 * Reports whether a role may be assigned at a scope.
 *
 * @param role - Fixed role.
 * @param scope - Assignment scope.
 * @returns True when the role is eligible at that scope.
 */
export function roleEligibleAt(role: RbacRole, scope: RbacScopeType): boolean {
  return ROLE_DEFINITIONS.get(role)?.scopes.includes(scope) ?? false;
}

/**
 * Reports whether a role contains an action.
 *
 * @param role - Fixed role.
 * @param action - Fixed action.
 * @returns True when the action belongs to the role.
 */
export function roleHasAction(role: RbacRole, action: RbacAction): boolean {
  return ROLE_DEFINITIONS.get(role)?.actions.includes(action) ?? false;
}
