/** Stable error codes for identity administration. */
export type IdentityErrorCode =
  | "access_denied"
  | "identity_inactive"
  | "identity_name_conflict"
  | "identity_not_found"
  | "validation_error";

/**
 * A domain error that the identity controller maps to an HTTP error envelope.
 *
 * Keeping the service independent from Express makes the authorization and
 * lifecycle rules testable without an HTTP request.
 */
export class IdentityServiceError extends Error {
  /** HTTP status code. */
  public readonly statusCode: number;
  /** Stable API error code. */
  public readonly code: IdentityErrorCode;

  /**
   * @param statusCode - HTTP status to return.
   * @param code - Stable error code.
   * @param message - Safe human-readable message.
   */
  public constructor(statusCode: number, code: IdentityErrorCode, message: string) {
    super(message);
    this.name = "IdentityServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
