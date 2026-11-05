/** Stable bootstrap failure codes. */
export type InitErrorCode =
  | "init_configuration"
  | "init_insecure"
  | "init_recovery_required"
  | "init_database"
  | "init_password"
  | "init_ca"
  | "init_tls";

/** One bootstrap failure. */
export class InitError extends Error {
  /**
   * @param code - Stable machine-readable code.
   * @param message - Short static message.
   * @param options - Optional cause.
   */
  public constructor(
    public readonly code: InitErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "InitError";
  }
}
