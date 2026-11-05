/** Stable operations failure codes. */
export type OpsErrorCode =
  | "ops_configuration"
  | "backup_failed"
  | "backup_target_exists"
  | "backup_archive_invalid"
  | "backup_checksum_mismatch"
  | "restore_failed"
  | "restore_target_not_empty"
  | "restore_requires_owner"
  | "restore_verification_failed"
  | "restore_archive_invalid"
  | "kek_rotation_failed"
  | "kek_rotation_incomplete"
  | "kek_rotation_requires_owner";

/** One backup, restore, or rotation failure. */
export class OpsError extends Error {
  /**
   * @param code - Stable machine-readable code.
   * @param message - Static message that never contains key or secret material.
   * @param options - Optional cause.
   */
  public constructor(
    public readonly code: OpsErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OpsError";
  }
}
