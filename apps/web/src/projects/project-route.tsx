import { Button } from "@fluentui/react-components";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { Link, Outlet, useLocation, useParams } from "react-router";
import { AsyncPanel, EmptyState } from "../components/feedback.js";
import { NavButton } from "../components/nav-button.js";
import type { OpenVaultWebClient } from "../generated/index.js";
import { useAsync } from "../hooks/use-async.js";
import { useSessionApi } from "../session/session-api-provider.js";

/** One project as returned by the list route. */
export type ProjectListItem = Awaited<
  ReturnType<OpenVaultWebClient["projects"]["listProjects"]>
>["projects"][number];

/** The resolved project shared by its pages. */
export interface ProjectContextValue {
  /** The project whose name is in the route. */
  readonly project: ProjectListItem;
  /** Every visible project, for switchers. */
  readonly projects: readonly ProjectListItem[];
  /** Reloads the list after a rename or delete. */
  readonly reload: () => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

/** Returns the resolved project. Throws outside `ProjectRoute`. */
export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (value === null) {
    throw new Error("useProject must be used inside ProjectRoute");
  }
  return value;
}

const SECTIONS = [
  { suffix: "", label: "Overview", end: true },
  { suffix: "/secrets", label: "Secrets", end: false },
  { suffix: "/rotation", label: "Rotation", end: false },
  { suffix: "/certificates", label: "Certificates", end: false },
  { suffix: "/identities", label: "Identities", end: false },
  { suffix: "/permissions", label: "Permissions", end: false },
  { suffix: "/audit", label: "Audit", end: false },
  { suffix: "/consumers", label: "Consumers", end: false },
] as const;

/**
 * Resolves `:project` by name and renders the project shell.
 *
 * A missing or deleted project renders a not-found panel rather than a
 * redirect, so a stale deep link is explicit. Every child page receives the
 * project id through `useProject()`.
 */
export function ProjectRoute() {
  const { project: projectName = "" } = useParams();
  const { client } = useSessionApi();
  const location = useLocation();
  const projects = useAsync(
    async (signal) => await client.projects.listProjects({ signal }),
    [client],
  );

  if (projects.loading) {
    return (
      <AsyncPanel loading error={undefined}>
        <span />
      </AsyncPanel>
    );
  }
  if (projects.error !== undefined) {
    return (
      <AsyncPanel loading={false} error={projects.error} onRetry={projects.reload}>
        <span />
      </AsyncPanel>
    );
  }
  const all = projects.data?.projects ?? [];
  const project = all.find((entry) => entry.name === projectName && entry.deletedAt === null);
  if (project === undefined) {
    return (
      <EmptyState
        title="Project not found"
        action={
          <NavButton to="/" appearance="primary">
            Back to projects
          </NavButton>
        }
      >
        <p>
          No active project named <code>{projectName}</code> is visible to your account.
        </p>
      </EmptyState>
    );
  }

  const base = `/projects/${encodeURIComponent(project.name)}`;
  return (
    <ProjectContext.Provider value={{ project, projects: all, reload: projects.reload }}>
      <div className="project-shell">
        <header className="project-context">
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <Link to="/">Projects</Link>
            <span aria-hidden="true"> / </span>
            <span>{project.name}</span>
          </nav>
          <div className="project-context-row">
            <div className="project-context-details">
              <p className="project-context-name">{project.name}</p>
              <p className="muted">
                Created {new Date(project.createdAt).toLocaleDateString()} ·{" "}
                {project.certificateCount} certificate
                {project.certificateCount === 1 ? "" : "s"} · id <code>{project.id}</code>
              </p>
            </div>
            <Button size="small" onClick={projects.reload}>
              Refresh
            </Button>
          </div>
        </header>
        <nav className="section-nav" aria-label="Project sections">
          {SECTIONS.map((section) => {
            const to = `${base}${section.suffix}`;
            const active =
              section.end === true
                ? location.pathname === base || location.pathname === `${base}/`
                : location.pathname.startsWith(to);
            return (
              <Link
                key={section.label}
                to={to}
                className={active ? "section-link section-link-active" : "section-link"}
                aria-current={active ? "page" : undefined}
              >
                {section.label}
              </Link>
            );
          })}
        </nav>
        <Outlet />
      </div>
    </ProjectContext.Provider>
  );
}

/** Wraps children with a project context in tests. */
export function ProjectContextFixture({
  value,
  children,
}: {
  readonly value: ProjectContextValue;
  readonly children: ReactNode;
}) {
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}
