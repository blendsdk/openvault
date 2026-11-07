/** Stable scaffold error codes. */
export type ScaffoldErrorCode =
  | "validation_error"
  | "access_denied"
  | "project_not_found"
  | "project_name_conflict"
  | "identity_scope_conflict"
  | "identity_inactive";

/** A scaffold failure with a stable HTTP status and code. */
export class ScaffoldServiceError extends Error {
  /**
   * @param statusCode - HTTP status.
   * @param code - Stable error code.
   * @param message - Short static message.
   */
  public constructor(
    public readonly statusCode: number,
    public readonly code: ScaffoldErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ScaffoldServiceError";
  }
}
