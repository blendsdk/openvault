import { Card, Text } from "@fluentui/react-components";
import { CliHint } from "../components/copy.js";
import { DataTable } from "../components/data-table.js";
import { AsyncPanel, EmptyState } from "../components/feedback.js";
import { PageHeader } from "../components/page-header.js";
import { formatTime, StatusBadge } from "../components/status.js";
import { useAsync } from "../hooks/use-async.js";
import { useProject } from "../projects/project-route.js";
import { useSessionApi } from "../session/session-api-provider.js";

interface ConsumerRow {
  readonly identityName: string;
  readonly identityId: string;
  readonly composeProject: string;
  readonly composeService: string;
  readonly state: "ok" | "degraded" | "failed";
  readonly lastSeen: string;
}

/** Compose consumers derived from service-identity detail. */
export function ConsumersPage() {
  const { project } = useProject();
  const { client } = useSessionApi();
  const consumers = useAsync(
    async (signal) => {
      const identities = await client.identities.listIdentities(
        { projectId: project.id },
        { signal },
      );
      const details = await Promise.all(
        identities.identities.map(async (identity) => {
          const detail = await client.identities.getIdentity({ id: identity.id }, { signal });
          return { identity, detail };
        }),
      );
      const rows: ConsumerRow[] = [];
      for (const entry of details) {
        const consumer = entry.detail.consumer;
        if (consumer === null) {
          continue;
        }
        rows.push({
          identityName: entry.identity.name,
          identityId: entry.identity.id,
          composeProject: consumer.composeProject,
          composeService: consumer.composeService,
          state: consumer.state,
          lastSeen: consumer.lastSeen,
        });
      }
      return rows;
    },
    [client, project.id],
  );

  return (
    <section className="page stack-lg">
      <PageHeader
        title="Consumers"
        description="Agents report the Compose project and service they deliver secrets to. Host paths are never shown."
      />
      <Card>
        <Text weight="semibold">Reported consumers</Text>
        <AsyncPanel
          loading={consumers.loading}
          error={consumers.error}
          onRetry={consumers.reload}
          loadingLabel="Loading consumers…"
        >
          {(consumers.data?.length ?? 0) === 0 ? (
            <EmptyState title="No consumers have joined">
              <p>
                A consumer appears after an agent joins with a one-time token and reports its
                Compose metadata.
              </p>
              <CliHint command={`ov identity join-token <name> --project ${project.name}`} />
            </EmptyState>
          ) : (
            <DataTable
              caption="Consumers"
              rows={consumers.data ?? []}
              rowKey={(row) => row.identityId}
              columns={[
                { key: "identity", header: "Identity", render: (row) => row.identityName },
                {
                  key: "project",
                  header: "Compose project",
                  render: (row) => row.composeProject,
                },
                {
                  key: "service",
                  header: "Compose service",
                  render: (row) => row.composeService,
                },
                {
                  key: "state",
                  header: "State",
                  render: (row) => <StatusBadge status={row.state} />,
                },
                {
                  key: "lastSeen",
                  header: "Last seen",
                  render: (row) => formatTime(row.lastSeen),
                },
              ]}
            />
          )}
        </AsyncPanel>
      </Card>
    </section>
  );
}
