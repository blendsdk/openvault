import { Button, MessageBar, MessageBarBody, MessageBarTitle } from "@fluentui/react-components";
import { describeError } from "../api/errors.js";
import { ErrorAlert } from "./feedback.js";

/**
 * Maps a rotation failure to the documented operator message.
 *
 * Unknown codes return undefined so the caller can keep the safe server text
 * and retry action from `ErrorAlert`. Raw stacks, SQL fragments, and internal
 * paths are never rendered.
 *
 * @param error - Failure from a rotation request.
 * @returns The documented message, or undefined for an unknown failure.
 */
export function rotationErrorText(error: unknown): string | undefined {
  const description = describeError(error);
  if (description.code === "secret_not_found" || description.notFound) {
    return "Secret not found.";
  }
  if (description.forbidden) {
    return "You do not have permission for this action.";
  }
  if (description.code === "validation_error") {
    return "The form values are not valid.";
  }
  if (description.code === "secret_version_limit") {
    return "This secret has reached its version limit.";
  }
  if (description.code === "idempotency_conflict") {
    return "The request conflicted with an earlier request. Try again.";
  }
  return undefined;
}

/** Renders a mapped rotation error, falling back to the safe server alert. */
export function RotationErrorAlert({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry?: (() => void) | undefined;
}) {
  const message = rotationErrorText(error);
  if (message === undefined) {
    return <ErrorAlert error={error} {...(onRetry === undefined ? {} : { onRetry })} />;
  }
  const description = describeError(error);
  return (
    <MessageBar intent="error" role="alert">
      <MessageBarBody>
        <MessageBarTitle>{description.title}</MessageBarTitle>
        <p className="error-message">{message}</p>
        {onRetry === undefined ? null : (
          <Button size="small" onClick={onRetry}>
            Try again
          </Button>
        )}
      </MessageBarBody>
    </MessageBar>
  );
}
