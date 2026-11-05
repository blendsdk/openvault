import { ApiError } from "blendsdk/api-client";

/** A stable, user-facing description of one failure. */
export interface ErrorDescription {
  /** Short label for the alert. */
  readonly title: string;
  /** Server code, when present. */
  readonly code?: string;
  /** Request id, when present. */
  readonly requestId?: string;
  /** Safe human message. */
  readonly message: string;
  /** True for 401. */
  readonly authentication: boolean;
  /** True for 403. */
  readonly forbidden: boolean;
  /** True for 404. */
  readonly notFound: boolean;
  /** True for 409. */
  readonly conflict: boolean;
}

/**
 * Converts one unknown failure into a display-safe description.
 *
 * Server messages are already user-facing and redacted; transport failures
 * receive a generic message. No stack trace or raw response is rendered.
 */
export function describeError(error: unknown): ErrorDescription {
  if (error instanceof ApiError) {
    const code = error.code.length > 0 ? error.code : undefined;
    return {
      title: titleForStatus(error.statusCode),
      ...(code === undefined ? {} : { code }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      message: error.message.length > 0 ? error.message : titleForStatus(error.statusCode),
      authentication: error.statusCode === 401,
      forbidden: error.statusCode === 403,
      notFound: error.statusCode === 404,
      conflict: error.statusCode === 409,
    };
  }
  if (error instanceof Error && error.message.length > 0 && error.name !== "TypeError") {
    return {
      title: "Request failed",
      message: error.message,
      authentication: false,
      forbidden: false,
      notFound: false,
      conflict: false,
    };
  }
  return {
    title: "Request failed",
    message: "The request could not be completed. Check the connection and try again.",
    authentication: false,
    forbidden: false,
    notFound: false,
    conflict: false,
  };
}

/** Maps one HTTP status to a short title. */
function titleForStatus(status: number): string {
  if (status === 400) {
    return "Invalid request";
  }
  if (status === 401) {
    return "Sign in required";
  }
  if (status === 403) {
    return "Access denied";
  }
  if (status === 404) {
    return "Not found";
  }
  if (status === 409) {
    return "Conflict";
  }
  if (status === 422) {
    return "Validation failed";
  }
  if (status === 429) {
    return "Too many requests";
  }
  if (status >= 500) {
    return "Server unavailable";
  }
  return "Request failed";
}

/** Returns true when an error is an aborted request. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
