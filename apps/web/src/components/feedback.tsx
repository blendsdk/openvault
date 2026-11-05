import { Loading } from "@blendsdk/fluentui-react-components";
import { Button, MessageBar, MessageBarBody, MessageBarTitle } from "@fluentui/react-components";
import type { ReactNode } from "react";
import { describeError } from "../api/errors.js";

/** One inline error with a stable code and optional retry. */
export function ErrorAlert({
  error,
  onRetry,
  retryLabel = "Try again",
}: {
  readonly error: unknown;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}) {
  const description = describeError(error);
  return (
    <MessageBar intent="error" role="alert">
      <MessageBarBody>
        <MessageBarTitle>{description.title}</MessageBarTitle>
        <p className="error-message">{description.message}</p>
        {description.code === undefined ? null : (
          <p className="error-code">
            {description.code}
            {description.requestId === undefined ? "" : ` · request ${description.requestId}`}
          </p>
        )}
        {onRetry === undefined ? null : (
          <Button size="small" onClick={onRetry}>
            {retryLabel}
          </Button>
        )}
      </MessageBarBody>
    </MessageBar>
  );
}

/** A labelled empty state with optional guidance content. */
export function EmptyState({
  title,
  children,
  action,
}: {
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <section className="empty-state" aria-labelledby="empty-state-title">
      <h2 id="empty-state-title" className="empty-state-title">
        {title}
      </h2>
      {children === undefined ? null : <div className="empty-state-copy">{children}</div>}
      {action === undefined ? null : <div className="empty-state-actions">{action}</div>}
    </section>
  );
}

/** Loading, error, empty, and content states behind one boundary. */
export function AsyncPanel({
  loading,
  error,
  empty,
  loadingLabel = "Loading…",
  onRetry,
  children,
}: {
  readonly loading: boolean;
  readonly error: unknown;
  readonly empty?: boolean;
  readonly loadingLabel?: string;
  readonly onRetry?: () => void;
  readonly children: ReactNode;
}) {
  if (loading) {
    return (
      <div className="async-panel" aria-busy="true">
        <Loading label={loadingLabel} minHeight={160} />
      </div>
    );
  }
  if (error !== undefined) {
    return (
      <div className="async-panel">
        <ErrorAlert error={error} {...(onRetry === undefined ? {} : { onRetry })} />
      </div>
    );
  }
  if (empty === true) {
    return null;
  }
  return <div className="async-panel">{children}</div>;
}
