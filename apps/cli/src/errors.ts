import { ApiError, ApiTransportError } from "blendsdk/api-client";

/** Stable CLI failure codes. */
export type CliErrorCode =
  | "usage_error"
  | "validation_error"
  | "authentication_required"
  | "access_denied"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "request_failed"
  | "service_unavailable"
  | "tls_verification_failed"
  | "request_timeout"
  | "response_too_large"
  | "credential_store_unavailable"
  | "credential_store_insecure"
  | "credential_store_corrupt"
  | "credential_store_locked"
  | "credential_store_unsupported"
  | "confirmation_required"
  | "file_exists"
  | "not_implemented"
  | "cancelled"
  | "agent_manifest_invalid"
  | "internal_error";

/** One stable CLI failure. */
export class CliError extends Error {
  /** Machine-readable code; server codes are preserved. */
  public readonly code: string;
  /** Process exit code. */
  public readonly exitCode: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Server request id, when present. */
  public readonly requestId: string | undefined;
  /** Optional structured detail. */
  public readonly details: unknown;

  /**
   * @param code - Stable machine-readable code.
   * @param message - Short static message.
   * @param options - Exit code, request id, and details.
   */
  public constructor(
    code: string,
    message: string,
    options: {
      readonly exitCode?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
      readonly requestId?: string;
      readonly details?: unknown;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CliError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

/** A completed command with a specific process exit code. */
export class CliExit extends Error {
  /**
   * @param exitCode - Process exit code.
   */
  public constructor(
    public readonly exitCode: number,
    public readonly output?: string,
  ) {
    super("Command completed");
    this.name = "CliExit";
  }
}

/** A refresh rejected by the server; mapped to an authentication failure. */
export class RefreshRejectedError extends Error {
  public constructor(message = "The CLI session is no longer valid; run ov login") {
    super(message);
    this.name = "RefreshRejectedError";
  }
}

/** Maps one HTTP status to a CLI exit code. */
export function exitCodeForStatus(status: number): 1 | 2 | 3 | 4 | 5 | 6 {
  if (status === 401) {
    return 3;
  }
  if (status === 403) {
    return 4;
  }
  if (status === 404) {
    return 5;
  }
  if (status === 409) {
    return 6;
  }
  if (status === 422) {
    return 2;
  }
  return 1;
}

/** Returns the known transport cause code, if any. */
function causeCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const cause = Reflect.get(error, "cause");
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }
  const code = Reflect.get(cause, "code");
  return typeof code === "string" ? code : undefined;
}

/** Returns the known transport cause message, if any. */
function causeMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const cause = Reflect.get(error, "cause");
  if (cause instanceof Error) {
    return cause.message;
  }
  return undefined;
}

/**
 * Converts one unknown failure into a stable CLI error.
 *
 * Server envelopes keep their code and request id. Transport causes are mapped
 * to fixed codes; raw cause text is never copied into the message.
 *
 * @param error - Thrown value.
 * @returns A CLI error.
 */
export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if (error instanceof RefreshRejectedError) {
    return new CliError("authentication_required", error.message, { exitCode: 3, cause: error });
  }
  if (error instanceof ApiError) {
    const code = error.code.length > 0 ? error.code : "request_failed";
    return new CliError(code, error.message, {
      exitCode: exitCodeForStatus(error.statusCode),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      ...(error.details === undefined ? {} : { details: error.details }),
      cause: error,
    });
  }
  if (error instanceof ApiTransportError) {
    const cause = error.cause;
    const causeName = cause instanceof Error ? cause.name : undefined;
    const causeText =
      cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    const text = `${error.message} ${causeText}`;
    if (causeName === "RefreshRejectedError") {
      return new CliError("authentication_required", "Run ov login", {
        exitCode: 3,
        cause: error,
      });
    }
    if (
      causeMessage(error) === "request_timeout" ||
      causeCode(error) === "ETIMEDOUT" ||
      /timed out|timeout/i.test(text)
    ) {
      return new CliError("request_timeout", "The request timed out", { cause: error });
    }
    if (/response_too_large|too large/i.test(text)) {
      return new CliError("response_too_large", "The response exceeded the CLI limit", {
        cause: error,
      });
    }
    if (/file_exists|already exists/i.test(text)) {
      return new CliError("file_exists", "The output file already exists; use --force", {
        cause: error,
      });
    }
    if (/certificate|self-signed|altnames|TLS|SSL|verify/i.test(text)) {
      return new CliError("tls_verification_failed", "The server TLS certificate was rejected", {
        cause: error,
      });
    }
    if (/aborted|cancelled/i.test(text)) {
      return new CliError("cancelled", "The request was cancelled", { cause: error });
    }
    return new CliError("request_failed", "The request failed before a response was received", {
      cause: error,
    });
  }
  if (error instanceof Error && error.name === "CommandLineValidationError") {
    const issues = Reflect.get(error, "issues");
    const message =
      Array.isArray(issues) && issues.length > 0
        ? issues
            .map((issue: unknown) =>
              issue instanceof Error ? issue.message : String(issue ?? "Invalid command line"),
            )
            .join("; ")
        : "Invalid command line";
    return new CliError("usage_error", message, { exitCode: 2, cause: error });
  }
  if (error instanceof Error && error.name === "OpsError") {
    const code =
      typeof Reflect.get(error, "code") === "string"
        ? (Reflect.get(error, "code") as string)
        : "ops_configuration";
    return new CliError(code, error.message, {
      exitCode: code === "ops_configuration" ? 2 : 1,
      cause: error,
    });
  }
  if (error instanceof Error && (error.name === "InitError" || error.name === "KeyringError")) {
    const code =
      typeof Reflect.get(error, "code") === "string"
        ? (Reflect.get(error, "code") as string)
        : "init_insecure";
    return new CliError(code, error.message, {
      exitCode: code === "init_configuration" ? 2 : 1,
      cause: error,
    });
  }
  if (error instanceof Error) {
    const text = error.message;
    if (/timed out|timeout/i.test(text)) {
      return new CliError("request_timeout", "The request timed out", { cause: error });
    }
    if (/too large|too_large/i.test(text)) {
      return new CliError("response_too_large", "The response exceeded the CLI limit", {
        cause: error,
      });
    }
    if (/file_exists|already exists/i.test(text)) {
      return new CliError("file_exists", "The output file already exists; use --force", {
        cause: error,
      });
    }
    if (/certificate|self-signed|altnames|TLS|SSL|verify/i.test(text)) {
      return new CliError("tls_verification_failed", "The server TLS certificate was rejected", {
        cause: error,
      });
    }
    if (/aborted|cancelled/i.test(text)) {
      return new CliError("cancelled", "The request was cancelled", { cause: error });
    }
  }
  return new CliError("internal_error", "The command failed", { cause: error });
}
