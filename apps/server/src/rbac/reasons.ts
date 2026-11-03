/**
 * Stable reason codes for policy decisions, grant guards, and admin errors.
 *
 * The evaluator uses the first six codes. The assignment service uses the
 * remaining codes for composite grant decisions and API errors. A code never
 * contains an identifier or user-controlled text.
 */
export type PolicyReason =
  | "allowed"
  | "inactive_principal"
  | "no_assignment"
  | "scope_mismatch"
  | "expired_assignment"
  | "service_control_plane"
  | "grant_scope_not_covered"
  | "grant_role_not_subset"
  | "grant_org_admin_forbidden"
  | "last_org_admin"
  | "unknown_principal"
  | "invalid_scope"
  | "duplicate_assignment";

/** Reason codes the evaluator can return for an ordinary decision. */
export const DECISION_REASONS: ReadonlySet<PolicyReason> = new Set<PolicyReason>([
  "allowed",
  "inactive_principal",
  "no_assignment",
  "scope_mismatch",
  "expired_assignment",
  "service_control_plane",
]);
