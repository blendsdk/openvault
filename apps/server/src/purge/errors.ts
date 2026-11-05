/** Stable error codes for the dedicated purger. */
export type VaultPurgerErrorCode = "project_not_found" | "target_not_found" | "service_unavailable";

/** Raised when the dedicated purge session rejects or a target is missing. */
export class VaultPurgerError extends Error {
  /** Stable code mapped by the secret and certificate services. */
  public readonly code: VaultPurgerErrorCode;

  /**
   * @param code - Stable error code.
   */
  public constructor(code: VaultPurgerErrorCode) {
    super("Vault purge is unavailable");
    this.name = "VaultPurgerError";
    this.code = code;
  }
}
