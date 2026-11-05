/**
 * Stable agent error codes.
 *
 * The codes are part of the operator contract: logs and CLI output use them,
 * and tests assert them. Error messages stay short and never include secret
 * values, tokens, PEM bodies, or raw network text.
 */
export type AgentErrorCode =
  | "agent_config_invalid"
  | "agent_manifest_invalid"
  | "agent_state_insecure"
  | "agent_state_write_failed"
  | "agent_join_token_required"
  | "agent_join_failed"
  | "agent_credential_rejected"
  | "agent_secret_not_found"
  | "agent_transient"
  | "agent_request_rejected"
  | "agent_renewal_not_due"
  | "agent_renewal_not_current"
  | "agent_renewal_terminal"
  | "agent_internal";

/** A stable, value-free agent failure. */
export class AgentError extends Error {
  /**
   * @param code - Stable machine-readable code.
   * @param message - Short static message.
   * @param options - Optional cause for local debugging; never serialized.
   */
  public constructor(
    public readonly code: AgentErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "AgentError";
  }
}

/**
 * Returns a safe error code for logging.
 *
 * @param error - Unknown thrown value.
 * @returns The stable code, or `agent_internal`.
 */
export function agentErrorCode(error: unknown): AgentErrorCode {
  return error instanceof AgentError ? error.code : "agent_internal";
}

/**
 * Returns a safe message for operator output.
 *
 * @param error - Unknown thrown value.
 * @returns A static message; unknown errors are collapsed.
 */
export function agentErrorMessage(error: unknown): string {
  return error instanceof AgentError ? error.message : "Agent operation failed";
}
