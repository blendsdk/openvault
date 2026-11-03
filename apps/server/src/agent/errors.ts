/** Stable agent API error codes. */
export type AgentErrorCode =
  | "access_denied"
  | "authentication_required"
  | "ca_unavailable"
  | "join_failed"
  | "renewal_not_current"
  | "renewal_not_due"
  | "service_unavailable"
  | "validation_error";

/**
 * Domain error translated into the stable WebAFX envelope by the agent
 * controller or middleware. Messages never contain token, CSR, or key bytes.
 */
export class AgentServiceError extends Error {
  /** HTTP status to return. */
  public readonly statusCode: number;
  /** Stable API error code. */
  public readonly code: AgentErrorCode;

  /**
   * @param statusCode - HTTP status to return.
   * @param code - Stable API error code.
   * @param message - Safe human-readable message.
   */
  public constructor(statusCode: number, code: AgentErrorCode, message: string) {
    super(message);
    this.name = "AgentServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
