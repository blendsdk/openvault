import type { ReactNode } from "react";
import { useEffect, useId, useRef } from "react";

/**
 * Page title, description, and actions.
 *
 * The heading receives focus on route changes so keyboard and screen-reader
 * users start at the new page rather than at the previous scroll position.
 */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  focusOnMount = true,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly eyebrow?: ReactNode;
  readonly focusOnMount?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (focusOnMount) {
      heading.current?.focus();
    }
  }, [focusOnMount]);
  return (
    <header className="page-header">
      <div className="page-header-text">
        {eyebrow === undefined ? null : <div className="page-eyebrow">{eyebrow}</div>}
        <h1 id={titleId} tabIndex={-1} ref={heading}>
          {title}
        </h1>
        {description === undefined ? null : <div className="page-description">{description}</div>}
      </div>
      {actions === undefined ? null : <div className="page-actions">{actions}</div>}
    </header>
  );
}
