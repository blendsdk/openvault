/** Stable error codes for the secret data plane. */
export type SecretErrorCode =
  | "access_denied"
  | "idempotency_conflict"
  | "project_not_found"
  | "purge_protection_locked"
  | "secret_expired"
  | "secret_integrity_failed"
  | "secret_name_conflict"
  | "secret_not_deleted"
  | "secret_not_found"
  | "secret_not_recoverable"
  | "secret_retention_active"
  | "secret_too_large"
  | "secret_version_limit"
  | "secret_version_not_found"
  | "service_unavailable"
  | "validation_error";

/**
 * A secret domain error mapped to the stable HTTP envelope by the controller.
 *
 * The service stays independent from Express so encryption, lifecycle, and
 * authorization rules are testable without a request.
 */
export class SecretServiceError extends Error {
  /** HTTP status code. */
  public readonly statusCode: number;
  /** Stable API error code. */
  public readonly code: SecretErrorCode;

  /**
   * @param statusCode - HTTP status to return.
   * @param code - Stable error code.
   * @param message - Safe human-readable message.
   */
  public constructor(statusCode: number, code: SecretErrorCode, message: string) {
    super(message);
    this.name = "SecretServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
