import { EmptyState } from "../components/feedback.js";
import { NavButton } from "../components/nav-button.js";

/** The client-side 404 page. */
export function NotFoundPage() {
  return (
    <section className="page">
      <EmptyState
        title="Page not found"
        action={
          <NavButton to="/" appearance="primary">
            Back to projects
          </NavButton>
        }
      >
        <p>The address does not match a page in this build.</p>
      </EmptyState>
    </section>
  );
}
