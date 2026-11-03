/** Public error codes for the RBAC admin surface. */
export type RbacErrorCode =
  | "access_denied"
  | "assignment_not_found"
  | "assignment_conflict"
  | "last_org_admin"
  | "service_control_plane"
  | "validation_error"
  | "service_unavailable"
  | "resource_not_found";

/**
 * Raised when the policy version, a policy read, or an audit write cannot
 * complete. It is a service failure, never an ordinary denial.
 */
export class PolicyUnavailableError extends Error {
  public constructor() {
    super("Authorization policy is unavailable");
    this.name = "PolicyUnavailableError";
  }
}

/**
 * A stable admin API failure with an HTTP status and public code.
 *
 * The message is safe to return; it never contains SQL, identifiers beyond the
 * caller's own input, or policy internals.
 */
export class RbacServiceError extends Error {
  /** HTTP status to return. */
  public readonly statusCode: number;
  /** Stable public error code. */
  public readonly code: RbacErrorCode;

  /**
   * @param statusCode - HTTP status.
   * @param code - Stable public code.
   * @param message - Safe message.
   */
  public constructor(statusCode: number, code: RbacErrorCode, message: string) {
    super(message);
    this.name = "RbacServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
