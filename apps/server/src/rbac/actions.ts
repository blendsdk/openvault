import { RBAC_ACTIONS, type RbacAction } from "@openvault/api-contract";

export { RBAC_ACTIONS, type RbacAction };

/** Public metadata for one fixed action. */
export interface ActionDefinition {
  /** Control-plane actions administer the platform; data-plane actions touch objects. */
  readonly plane: "control" | "data";
  /** One-line meaning published in the role reference. */
  readonly description: string;
}

/**
 * The single action catalog used by the evaluator, meta route, and tests.
 *
 * The map is immutable and keyed by the contract union, so a misspelled action
 * cannot enter a role definition.
 */
export const ACTION_DEFINITIONS: ReadonlyMap<RbacAction, ActionDefinition> = new Map<
  RbacAction,
  ActionDefinition
>([
  ["project.create", { plane: "control", description: "Create a project" }],
  ["project.read", { plane: "control", description: "Read project metadata" }],
  ["project.update", { plane: "control", description: "Change project metadata" }],
  ["project.delete", { plane: "control", description: "Soft-delete a project" }],
  ["identity.create", { plane: "control", description: "Create a service identity" }],
  ["identity.read", { plane: "control", description: "Read identity metadata" }],
  [
    "identity.revoke",
    { plane: "control", description: "Disable an identity and revoke credentials" },
  ],
  ["identity.join_token", { plane: "control", description: "Issue a one-time join token" }],
  [
    "assignment.read",
    { plane: "control", description: "Read assignments and access explanations" },
  ],
  ["assignment.write", { plane: "control", description: "Grant or revoke roles" }],
  ["audit.read", { plane: "control", description: "Read or export audit events" }],
  ["kek.rotate", { plane: "control", description: "Start KEK rotation" }],
  ["secret.list", { plane: "data", description: "List secret metadata" }],
  ["secret.read", { plane: "data", description: "Read a secret value" }],
  ["secret.write", { plane: "data", description: "Create or update a secret" }],
  ["secret.delete", { plane: "data", description: "Soft-delete a secret" }],
  ["secret.recover", { plane: "data", description: "Recover a soft-deleted secret" }],
  ["secret.purge", { plane: "data", description: "Permanently delete a secret" }],
  ["certificate.list", { plane: "data", description: "List certificate metadata" }],
  ["certificate.read", { plane: "data", description: "Read a certificate chain" }],
  ["certificate.read_private", { plane: "data", description: "Read a certificate private key" }],
  ["certificate.write", { plane: "data", description: "Import or update a certificate" }],
  ["certificate.delete", { plane: "data", description: "Soft-delete a certificate" }],
  ["certificate.recover", { plane: "data", description: "Recover a soft-deleted certificate" }],
  ["certificate.purge", { plane: "data", description: "Permanently delete a certificate" }],
]);

/**
 * Reports whether an action is control-plane.
 *
 * @param action - Catalog action.
 * @returns True for an administrative action.
 */
export function isControlPlaneAction(action: RbacAction): boolean {
  return ACTION_DEFINITIONS.get(action)?.plane === "control";
}
