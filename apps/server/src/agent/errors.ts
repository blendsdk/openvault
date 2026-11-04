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

/** Stable internal reasons stored on agent failure events. */
export type AgentAuditReason =
  | "invalid_csr"
  | "join_token_unknown"
  | "join_token_expired"
  | "join_token_used"
  | "join_token_revoked"
  | "join_token_claim_failed"
  | "principal_inactive"
  | "project_inactive"
  | "renewal_not_current"
  | "renewal_not_due"
  | "ca_unavailable"
  | "certificate_conflict"
  | "internal_error";

/**
 * Domain error translated into the stable WebAFX envelope by the agent
 * controller or middleware. Messages never contain token, CSR, or key bytes.
 */
export class AgentServiceError extends Error {
  /** HTTP status to return. */
  public readonly statusCode: number;
  /** Stable API error code. */
  public readonly code: AgentErrorCode;
  /** Internal audit reason, when the failure is audited. */
  public readonly reason: AgentAuditReason | undefined;

  /**
   * @param statusCode - HTTP status to return.
   * @param code - Stable API error code.
   * @param message - Safe human-readable message.
   * @param reason - Internal audit reason.
   */
  public constructor(
    statusCode: number,
    code: AgentErrorCode,
    message: string,
    reason?: AgentAuditReason,
  ) {
    super(message);
    this.name = "AgentServiceError";
    this.statusCode = statusCode;
    this.code = code;
    this.reason = reason;
  }
}
