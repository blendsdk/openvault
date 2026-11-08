import { Button, MessageBar, MessageBarBody, MessageBarTitle } from "@fluentui/react-components";
import { describeError } from "../api/errors.js";
import { ErrorAlert } from "./feedback.js";

/**
 * Maps a certificate failure to the documented operator message.
 *
 * Unknown codes return undefined so the caller can keep the safe server text
 * and retry action from `ErrorAlert`. Raw stacks, SQL fragments, and internal
 * paths are never rendered.
 *
 * @param error - Failure from a certificate request.
 * @returns The documented message, or undefined for an unknown failure.
 */
export function certificateErrorText(error: unknown): string | undefined {
  const description = describeError(error);
  if (description.code === "certificate_version_conflict") {
    return "This certificate changed. Reload the page and try again.";
  }
  if (description.code === "purge_protection_locked") {
    return "Purge protection is on and cannot be turned off.";
  }
  if (description.code === "certificate_retention_active") {
    return "The retention period has not ended. Purge is available after the displayed date.";
  }
  if (description.code === "certificate_not_found" || description.notFound) {
    return "Certificate not found.";
  }
  if (description.forbidden) {
    return "You do not have permission for this action.";
  }
  if (description.code === "validation_error") {
    return "The form values are not valid.";
  }
  return undefined;
}

/** Renders a mapped certificate error, falling back to the safe server alert. */
export function CertificateErrorAlert({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry?: (() => void) | undefined;
}) {
  const message = certificateErrorText(error);
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
