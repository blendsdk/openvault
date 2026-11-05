/** Stable error codes for the certificate data plane. */
export type CertificateErrorCode =
  | "access_denied"
  | "certificate_expired"
  | "certificate_integrity_failed"
  | "certificate_name_conflict"
  | "certificate_not_deleted"
  | "certificate_not_found"
  | "certificate_not_recoverable"
  | "certificate_retention_active"
  | "certificate_too_large"
  | "certificate_version_conflict"
  | "certificate_version_not_found"
  | "certificate_version_limit"
  | "idempotency_conflict"
  | "project_not_found"
  | "purge_protection_locked"
  | "service_unavailable"
  | "validation_error";

/**
 * A certificate domain error mapped to the stable HTTP envelope by the controller.
 *
 * The service stays independent from Express so PEM parsing, encryption, lifecycle, and
 * authorization rules are testable without a request.
 */
export class CertificateServiceError extends Error {
  /** HTTP status code. */
  public readonly statusCode: number;
  /** Stable API error code. */
  public readonly code: CertificateErrorCode;

  /**
   * @param statusCode - HTTP status to return.
   * @param code - Stable error code.
   * @param message - Safe human-readable message.
   */
  public constructor(statusCode: number, code: CertificateErrorCode, message: string) {
    super(message);
    this.name = "CertificateServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
