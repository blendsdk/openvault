import { DescriptionList, DescriptionListItem } from "@blendsdk/fluentui-react-components";
import { Button, Card, Dropdown, Field, Input, Option, Text } from "@fluentui/react-components";
import { AUDIT_ACTIONS } from "@openvault/api-contract/actions";
import { useEffect, useState } from "react";
import { DataTable } from "../components/data-table.js";
import { AsyncPanel, EmptyState, ErrorAlert } from "../components/feedback.js";
import { PageHeader } from "../components/page-header.js";
import { asText, asTextOr, formatTime, StatusBadge } from "../components/status.js";
import type { AuditListAuditEventsParams, OpenVaultWebClient } from "../generated/index.js";
import { useAsync } from "../hooks/use-async.js";
import { useProject } from "../projects/project-route.js";
import { useSessionApi } from "../session/session-api-provider.js";

type AuditEvent = Awaited<
  ReturnType<OpenVaultWebClient["audit"]["listAuditEvents"]>
>["events"][number];

interface Filters {
  from: string;
  to: string;
  actorId: string;
  action: string;
  objectType: string;
  objectId: string;
  result: string;
  requestId: string;
}

const EMPTY_FILTERS: Filters = {
  from: "",
  to: "",
  actorId: "",
  action: "",
  objectType: "",
  objectId: "",
  result: "",
  requestId: "",
};

/** Converts a local datetime-local value to an ISO timestamp. */
function toIso(value: string): string | undefined {
  if (value.length === 0) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** Audit search with filters, chain verification, and event details. */
export function AuditPage() {
  const { project } = useProject();
  const { client } = useSessionApi();
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [extra, setExtra] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(undefined);
  const [selected, setSelected] = useState<AuditEvent | undefined>(undefined);
  const [verifyResult, setVerifyResult] = useState<
    Awaited<ReturnType<OpenVaultWebClient["audit"]["verifyAudit"]>> | undefined
  >(undefined);
  const [verifyFailure, setVerifyFailure] = useState<unknown>(undefined);
  const [verifying, setVerifying] = useState(false);

  const from = toIso(filters.from);
  const to = toIso(filters.to);
  const result =
    filters.result === "allow" || filters.result === "deny" || filters.result === "error"
      ? filters.result
      : undefined;
  const applied: AuditListAuditEventsParams = {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(filters.actorId.length === 0 ? {} : { actorId: filters.actorId }),
    ...(filters.action.length === 0
      ? {}
      : { action: filters.action as NonNullable<AuditListAuditEventsParams["action"]> }),
    ...(filters.objectType.length === 0 ? {} : { objectType: filters.objectType }),
    ...(filters.objectId.length === 0 ? {} : { objectId: filters.objectId }),
    ...(result === undefined ? {} : { result }),
    ...(filters.requestId.length === 0 ? {} : { requestId: filters.requestId }),
  };

  const page = useAsync(
    async (signal) =>
      await client.audit.listAuditEvents(
        {
          projectId: project.id,
          limit: 50,
          ...(applied.from === undefined ? {} : { from: applied.from }),
          ...(applied.to === undefined ? {} : { to: applied.to }),
          ...(applied.actorId === undefined ? {} : { actorId: applied.actorId }),
          ...(applied.action === undefined ? {} : { action: applied.action }),
          ...(applied.objectType === undefined ? {} : { objectType: applied.objectType }),
          ...(applied.objectId === undefined ? {} : { objectId: applied.objectId }),
          ...(applied.result === undefined ? {} : { result: applied.result }),
          ...(applied.requestId === undefined ? {} : { requestId: applied.requestId }),
        },
        { signal },
      ),
    [
      client,
      project.id,
      applied.from,
      applied.to,
      applied.actorId,
      applied.action,
      applied.objectType,
      applied.objectId,
      applied.result,
      applied.requestId,
    ],
  );

  useEffect(() => {
    setExtra([]);
    setNextCursor(page.data?.nextCursor ?? null);
    setSelected(undefined);
  }, [page.data]);

  const events = [...(page.data?.events ?? []), ...extra];

  const loadMore = async (): Promise<void> => {
    if (nextCursor === null) {
      return;
    }
    setMoreLoading(true);
    setMoreError(undefined);
    try {
      const next = await client.audit.listAuditEvents({
        projectId: project.id,
        limit: 50,
        cursor: nextCursor,
        ...(applied.from === undefined ? {} : { from: applied.from }),
        ...(applied.to === undefined ? {} : { to: applied.to }),
        ...(applied.actorId === undefined ? {} : { actorId: applied.actorId }),
        ...(applied.action === undefined ? {} : { action: applied.action }),
        ...(applied.objectType === undefined ? {} : { objectType: applied.objectType }),
        ...(applied.objectId === undefined ? {} : { objectId: applied.objectId }),
        ...(applied.result === undefined ? {} : { result: applied.result }),
        ...(applied.requestId === undefined ? {} : { requestId: applied.requestId }),
      });
      setExtra((current) => [...current, ...next.events]);
      setNextCursor(next.nextCursor);
    } catch (error) {
      setMoreError(error);
    } finally {
      setMoreLoading(false);
    }
  };

  const verify = async (): Promise<void> => {
    setVerifying(true);
    setVerifyFailure(undefined);
    try {
      setVerifyResult(await client.audit.verifyAudit());
    } catch (error) {
      setVerifyResult(undefined);
      setVerifyFailure(error);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <section className="page stack-lg">
      <PageHeader
        title="Audit"
        description="Search the tamper-evident event chain for this project."
      />

      <Card>
        <div className="card-heading">
          <Text weight="semibold">Chain verification</Text>
          <Button appearance="primary" onClick={() => void verify()} disabled={verifying}>
            {verifying ? "Verifying…" : "Verify chain"}
          </Button>
        </div>
        {verifyFailure === undefined ? null : <ErrorAlert error={verifyFailure} />}
        {verifyResult === undefined ? (
          <p className="muted">Verification is explicit and records an audit event.</p>
        ) : (
          <section className="stack" aria-live="polite">
            <p>
              <StatusBadge status={verifyResult.ok ? "ok" : "failed"} />{" "}
              {verifyResult.ok
                ? "The chain is intact."
                : `The chain is broken (${verifyResult.reason}).`}
            </p>
            {verifyResult.firstBrokenEventId === null ? null : (
              <p>
                First broken event: <code>{asText(verifyResult.firstBrokenEventId)}</code>
              </p>
            )}
            {verifyResult.checkedRange === null ? null : (
              <p className="muted">
                Checked {asTextOr(verifyResult.checkedRange.fromEventId, "start")} to{" "}
                {asTextOr(verifyResult.checkedRange.toEventId, "end")}.
              </p>
            )}
          </section>
        )}
      </Card>

      <Card>
        <form
          className="filter-grid"
          onSubmit={(event) => {
            event.preventDefault();
            setFilters(draft);
          }}
        >
          <Field label="From">
            <Input
              type="datetime-local"
              value={draft.from}
              onChange={(_event, data) => setDraft({ ...draft, from: data.value })}
            />
          </Field>
          <Field label="To">
            <Input
              type="datetime-local"
              value={draft.to}
              onChange={(_event, data) => setDraft({ ...draft, to: data.value })}
            />
          </Field>
          <Field label="Actor id">
            <Input
              value={draft.actorId}
              onChange={(_event, data) => setDraft({ ...draft, actorId: data.value })}
              placeholder="ULID"
            />
          </Field>
          <Field label="Action">
            <Dropdown
              value={draft.action}
              selectedOptions={draft.action.length === 0 ? [] : [draft.action]}
              onOptionSelect={(_event, data) =>
                setDraft({ ...draft, action: data.optionValue ?? "" })
              }
            >
              {AUDIT_ACTIONS.map((action) => (
                <Option key={action} value={action}>
                  {action}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="Object type">
            <Input
              value={draft.objectType}
              onChange={(_event, data) => setDraft({ ...draft, objectType: data.value })}
              placeholder="secret"
            />
          </Field>
          <Field label="Object id">
            <Input
              value={draft.objectId}
              onChange={(_event, data) => setDraft({ ...draft, objectId: data.value })}
              placeholder="ULID"
            />
          </Field>
          <Field label="Result">
            <Dropdown
              value={draft.result}
              selectedOptions={draft.result.length === 0 ? [] : [draft.result]}
              onOptionSelect={(_event, data) =>
                setDraft({ ...draft, result: data.optionValue ?? "" })
              }
            >
              <Option value="allow">allow</Option>
              <Option value="deny">deny</Option>
              <Option value="error">error</Option>
            </Dropdown>
          </Field>
          <Field label="Request id">
            <Input
              value={draft.requestId}
              onChange={(_event, data) => setDraft({ ...draft, requestId: data.value })}
            />
          </Field>
          <div className="filter-actions">
            <Button type="submit" appearance="primary">
              Apply filters
            </Button>
            <Button
              type="button"
              appearance="subtle"
              onClick={() => {
                setDraft(EMPTY_FILTERS);
                setFilters(EMPTY_FILTERS);
              }}
            >
              Clear
            </Button>
          </div>
        </form>
      </Card>

      <AsyncPanel
        loading={page.loading}
        error={page.error}
        onRetry={page.reload}
        loadingLabel="Loading audit events…"
      >
        {events.length === 0 ? (
          <EmptyState title="No matching audit events">
            <p>Adjust the filters or verify that your role includes audit access.</p>
          </EmptyState>
        ) : (
          <>
            <DataTable
              caption="Audit events"
              rows={events}
              rowKey={(event) => event.eventId}
              busy={page.loading || moreLoading}
              columns={[
                { key: "time", header: "Time", render: (event) => formatTime(event.ts) },
                {
                  key: "actor",
                  header: "Actor",
                  render: (event) => asText(event.actorId ?? event.actorKind),
                },
                { key: "action", header: "Action", render: (event) => event.action },
                {
                  key: "result",
                  header: "Result",
                  render: (event) => (
                    <StatusBadge
                      status={
                        event.result === "allow"
                          ? "ok"
                          : event.result === "deny"
                            ? "failed"
                            : "degraded"
                      }
                      label={event.result}
                    />
                  ),
                },
                {
                  key: "object",
                  header: "Object",
                  render: (event) =>
                    event.objectType === null
                      ? "—"
                      : `${event.objectType}: ${event.objectId ?? "—"}`,
                },
                {
                  key: "request",
                  header: "Request",
                  render: (event) => <code>{event.requestId}</code>,
                },
                {
                  key: "details",
                  header: "Details",
                  render: (event) => (
                    <Button size="small" appearance="subtle" onClick={() => setSelected(event)}>
                      View
                    </Button>
                  ),
                },
              ]}
            />
            {moreError === undefined ? null : <ErrorAlert error={moreError} />}
            {nextCursor === null ? null : (
              <Button appearance="secondary" onClick={() => void loadMore()} disabled={moreLoading}>
                {moreLoading ? "Loading…" : "Load more"}
              </Button>
            )}
          </>
        )}
      </AsyncPanel>

      {selected === undefined ? null : (
        <Card>
          <div className="card-heading">
            <Text weight="semibold">Event {selected.eventId}</Text>
            <Button appearance="subtle" onClick={() => setSelected(undefined)}>
              Close
            </Button>
          </div>
          <DescriptionList layout="columns">
            <DescriptionListItem label="Time">{formatTime(selected.ts)}</DescriptionListItem>
            <DescriptionListItem label="Action">{selected.action}</DescriptionListItem>
            <DescriptionListItem label="Actor">
              {asText(selected.actorId ?? selected.actorKind)}
            </DescriptionListItem>
            <DescriptionListItem label="Result">{selected.result}</DescriptionListItem>
            <DescriptionListItem label="Request">{selected.requestId}</DescriptionListItem>
            <DescriptionListItem label="Source IP">{selected.sourceIp ?? "—"}</DescriptionListItem>
          </DescriptionList>
          <pre className="details-json">{JSON.stringify(selected.details, null, 2)}</pre>
        </Card>
      )}
    </section>
  );
}
