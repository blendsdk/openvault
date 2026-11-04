/** Stable error codes for project administration. */
export type ProjectErrorCode =
  | "access_denied"
  | "project_name_conflict"
  | "project_not_found"
  | "validation_error";

/**
 * A project domain error mapped to the stable HTTP envelope by the controller.
 *
 * The service stays independent from Express so lifecycle and authorization
 * rules are testable without a request.
 */
export class ProjectServiceError extends Error {
  /** HTTP status code. */
  public readonly statusCode: number;
  /** Stable API error code. */
  public readonly code: ProjectErrorCode;

  /**
   * @param statusCode - HTTP status to return.
   * @param code - Stable error code.
   * @param message - Safe human-readable message.
   */
  public constructor(statusCode: number, code: ProjectErrorCode, message: string) {
    super(message);
    this.name = "ProjectServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
