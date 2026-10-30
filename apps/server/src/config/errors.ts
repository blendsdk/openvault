/**
 * Raised when a required environment value is missing, malformed, or unsafe.
 *
 * The error carries the environment variable name so startup can report the
 * affected key without printing the value. Messages never include the value or
 * the contents of a referenced file.
 */
export class ConfigError extends Error {
  /** Environment variable that owns the invalid value. */
  public readonly key: string;

  public constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "ConfigError";
    this.key = key;
  }
}
