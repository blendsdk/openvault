import { DescriptionList, DescriptionListItem } from "@blendsdk/fluentui-react-components";
import { Card, Text } from "@fluentui/react-components";
import { AsyncPanel } from "../components/feedback.js";
import { NavButton } from "../components/nav-button.js";
import { PageHeader } from "../components/page-header.js";
import { formatTime, StatusBadge } from "../components/status.js";
import { useAsync } from "../hooks/use-async.js";
import { useProject } from "../projects/project-route.js";
import { useSessionApi } from "../session/session-api-provider.js";

/** Project summary with live counts and recent activity. */
export function ProjectOverviewPage() {
  const { project } = useProject();
  const { client } = useSessionApi();
  const secrets = useAsync(
    async (signal) =>
      await client.secrets.listSecrets({ project: project.name, limit: 5 }, { signal }),
    [client, project.name],
  );
  const identities = useAsync(
    async (signal) => await client.identities.listIdentities({ projectId: project.id }, { signal }),
    [client, project.id],
  );
  const assignments = useAsync(
    async (signal) =>
      await client.assignments.listAssignments(
        { scopeType: "project", scopeId: project.id },
        { signal },
      ),
    [client, project.id],
  );
  const audit = useAsync(
    async (signal) =>
      await client.audit.listAuditEvents({ projectId: project.id, limit: 5 }, { signal }),
    [client, project.id],
  );

  const base = `/projects/${encodeURIComponent(project.name)}`;
  return (
    <section className="page stack-lg">
      <PageHeader
        title="Overview"
        description="Project summary, counts, and recent audit activity."
      />
      <DescriptionList layout="columns">
        <DescriptionListItem label="Project id">
          <code>{project.id}</code>
        </DescriptionListItem>
        <DescriptionListItem label="Created">{formatTime(project.createdAt)}</DescriptionListItem>
        <DescriptionListItem label="Updated">{formatTime(project.updatedAt)}</DescriptionListItem>
        <DescriptionListItem label="Certificates">{project.certificateCount}</DescriptionListItem>
      </DescriptionList>

      <div className="summary-grid">
        <Card className="summary-card">
          <Text weight="semibold">Recent secrets</Text>
          <AsyncPanel loading={secrets.loading} error={secrets.error} onRetry={secrets.reload}>
            <p className="summary-count">{secrets.data?.secrets.length ?? 0}</p>
            <p className="muted">
              {secrets.data?.nextCursor === null || secrets.data?.nextCursor === undefined
                ? "All current secrets"
                : "More secrets available"}
            </p>
            <NavButton to={`${base}/secrets`}>Open secrets</NavButton>
          </AsyncPanel>
        </Card>
        <Card className="summary-card">
          <Text weight="semibold">Identities</Text>
          <AsyncPanel
            loading={identities.loading}
            error={identities.error}
            onRetry={identities.reload}
          >
            <p className="summary-count">{identities.data?.identities.length ?? 0}</p>
            <p className="muted">Service principals with mTLS access</p>
            <NavButton to={`${base}/identities`}>Open identities</NavButton>
          </AsyncPanel>
        </Card>
        <Card className="summary-card">
          <Text weight="semibold">Assignments</Text>
          <AsyncPanel
            loading={assignments.loading}
            error={assignments.error}
            onRetry={assignments.reload}
          >
            <p className="summary-count">{assignments.data?.assignments.length ?? 0}</p>
            <p className="muted">Project-scope grants</p>
            <NavButton to={`${base}/permissions`}>Open permissions</NavButton>
          </AsyncPanel>
        </Card>
      </div>

      <Card className="summary-card">
        <div className="card-heading">
          <Text weight="semibold">Recent audit activity</Text>
          <NavButton to={`${base}/audit`}>Open audit</NavButton>
        </div>
        <AsyncPanel loading={audit.loading} error={audit.error} onRetry={audit.reload}>
          {(audit.data?.events.length ?? 0) === 0 ? (
            <p className="muted">No audit events are visible for this project yet.</p>
          ) : (
            <ul className="event-list">
              {audit.data?.events.map((event) => (
                <li key={event.eventId}>
                  <span className="event-action">{event.action}</span>
                  <StatusBadge status={event.result === "allow" ? "ok" : "failed"} />
                  <span className="muted">{formatTime(event.ts)}</span>
                </li>
              ))}
            </ul>
          )}
        </AsyncPanel>
      </Card>
    </section>
  );
}
