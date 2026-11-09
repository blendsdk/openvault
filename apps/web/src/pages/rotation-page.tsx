import { Badge, Button, Field, Input, Select } from "@fluentui/react-components";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { DataTable } from "../components/data-table.js";
import { AsyncPanel, EmptyState, ErrorAlert } from "../components/feedback.js";
import { NavButton } from "../components/nav-button.js";
import { PageHeader } from "../components/page-header.js";
import { formatTime } from "../components/status.js";
import type { OpenVaultWebClient } from "../generated/index.js";
import { useAsync } from "../hooks/use-async.js";
import { useProject } from "../projects/project-route.js";
import { useSessionApi } from "../session/session-api-provider.js";

type RotationSecret = Awaited<
  ReturnType<OpenVaultWebClient["secrets"]["listSecrets"]>
>["secrets"][number];

type RotationFilter = "policy" | "due" | "overdue";

interface Filters {
  readonly q: string;
  readonly status: RotationFilter;
}

const EMPTY_FILTERS: Filters = { q: "", status: "policy" };

/** Reads one valid status from the URL. */
function statusFromSearch(value: string | null): RotationFilter {
  return value === "due" || value === "overdue" ? value : "policy";
}

/** Formats a due date with a relative day count. */
function dueLabel(secret: RotationSecret): string {
  if (secret.rotationDueAt === null) {
    return "—";
  }
  const due = Date.parse(secret.rotationDueAt);
  const days = Math.ceil((due - Date.now()) / 86_400_000);
  const relative =
    days === 0
      ? "today"
      : days > 0
        ? `in ${days} day${days === 1 ? "" : "s"}`
        : `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`;
  return `${formatTime(secret.rotationDueAt)} (${relative})`;
}

/** The status badge color and label. */
function rotationBadge(status: RotationSecret["rotationStatus"]) {
  const label = typeof status === "string" ? status : "—";
  const color = label === "overdue" ? "danger" : label === "due_soon" ? "warning" : "success";
  return (
    <Badge appearance="tint" color={color}>
      {label}
    </Badge>
  );
}

/**
 * Project rotation page.
 *
 * Lists only secrets with a policy by default. The URL `status` parameter
 * seeds the filter so the secrets-list "Needs rotation" link lands on the
 * due view.
 */
export function RotationPage() {
  const { project } = useProject();
  const { client } = useSessionApi();
  const [params] = useSearchParams();
  const [draft, setDraft] = useState<Filters>(() => ({
    q: "",
    status: statusFromSearch(params.get("status")),
  }));
  const [filters, setFilters] = useState<Filters>(draft);
  const [extra, setExtra] = useState<RotationSecret[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(undefined);
  const moreToken = useRef(0);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const page = useAsync(
    async (signal) =>
      await client.secrets.listSecrets(
        {
          project: project.name,
          limit: 25,
          rotation: filters.status,
          ...(filters.q.length === 0 ? {} : { q: filters.q }),
        },
        { signal },
      ),
    [client, project.name, filters.q, filters.status],
  );

  useEffect(() => {
    moreToken.current += 1;
    setExtra([]);
    setNextCursor(page.data?.nextCursor ?? null);
    setMoreLoading(false);
    setMoreError(undefined);
  }, [page.data]);

  const items = [...(page.data?.secrets ?? []), ...extra];
  const loadMore = async (): Promise<void> => {
    if (nextCursor === null) {
      return;
    }
    const token = ++moreToken.current;
    const requested = filters;
    setMoreLoading(true);
    setMoreError(undefined);
    try {
      const next = await client.secrets.listSecrets({
        project: project.name,
        limit: 25,
        cursor: nextCursor,
        rotation: filters.status,
        ...(filters.q.length === 0 ? {} : { q: filters.q }),
      });
      if (token !== moreToken.current || filtersRef.current !== requested) {
        return;
      }
      setExtra((current) => [...current, ...next.secrets]);
      setNextCursor(next.nextCursor);
    } catch (error) {
      if (token === moreToken.current) {
        setMoreError(error);
      }
    } finally {
      if (token === moreToken.current) {
        setMoreLoading(false);
      }
    }
  };

  const base = `/projects/${encodeURIComponent(project.name)}`;
  const clear = (): void => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
  };

  return (
    <section className="page">
      <PageHeader
        title="Rotation"
        description="Secrets with a rotation policy, their due state, and the rotation action."
      />
      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters(draft);
        }}
      >
        <Field label="Search">
          <Input
            value={draft.q}
            onChange={(_event, data) => setDraft({ ...draft, q: data.value })}
          />
        </Field>
        <Field label="Status">
          <Select
            value={draft.status}
            onChange={(event) =>
              setDraft({ ...draft, status: event.target.value as RotationFilter })
            }
          >
            <option value="policy">All policies</option>
            <option value="due">Needs attention</option>
            <option value="overdue">Overdue</option>
          </Select>
        </Field>
        <Button type="submit" appearance="primary">
          Apply filters
        </Button>
        <Button type="button" appearance="secondary" onClick={clear}>
          Clear
        </Button>
      </form>

      {page.error !== undefined ? (
        <ErrorAlert error={page.error} />
      ) : (
        <AsyncPanel loading={page.loading} error={page.error} onRetry={page.reload}>
          {items.length === 0 ? (
            filters.q.length > 0 || filters.status !== "policy" ? (
              <EmptyState
                title={filters.status === "overdue" ? "Nothing is overdue" : "No secrets match"}
                action={
                  <Button appearance="secondary" onClick={clear}>
                    {filters.status === "overdue" ? "Back to all policies" : "Clear filters"}
                  </Button>
                }
              >
                <p>Change the filters to see other rotation policies.</p>
              </EmptyState>
            ) : (
              <EmptyState
                title="No rotation policies yet"
                action={
                  <NavButton to={`${base}/secrets`} appearance="primary">
                    Set a policy from a secret
                  </NavButton>
                }
              >
                <p>Open a secret and set an interval to start tracking rotation.</p>
              </EmptyState>
            )
          ) : (
            <>
              <DataTable
                caption="Secrets with a rotation policy"
                rows={items}
                rowKey={(secret) => secret.id}
                columns={[
                  {
                    key: "name",
                    header: "Name",
                    render: (secret) => (
                      <Link to={`${base}/secrets/${encodeURIComponent(secret.name)}`}>
                        {secret.name}
                      </Link>
                    ),
                  },
                  {
                    key: "status",
                    header: "Status",
                    render: (secret) => rotationBadge(secret.rotationStatus),
                  },
                  {
                    key: "due",
                    header: "Due",
                    render: (secret) => dueLabel(secret),
                  },
                  {
                    key: "interval",
                    header: "Interval",
                    render: (secret) =>
                      secret.rotationIntervalDays === null
                        ? "—"
                        : `every ${secret.rotationIntervalDays} days`,
                  },
                  {
                    key: "last",
                    header: "Last rotated",
                    render: (secret) => formatTime(secret.currentVersion?.createdAt),
                  },
                  {
                    key: "consumers",
                    header: "Consumers",
                    render: (secret) => String(secret.consumers.length),
                  },
                  {
                    key: "action",
                    header: "Action",
                    render: (secret) =>
                      secret.capabilities.canWrite ? (
                        <Button size="small" appearance="secondary">
                          Rotate
                        </Button>
                      ) : null,
                  },
                ]}
              />
              {nextCursor === null ? null : (
                <div className="row-actions">
                  <Button
                    appearance="secondary"
                    onClick={() => void loadMore()}
                    disabled={moreLoading}
                  >
                    {moreLoading ? "Loading…" : "Load more"}
                  </Button>
                  {moreError === undefined ? null : <ErrorAlert error={moreError} />}
                </div>
              )}
            </>
          )}
        </AsyncPanel>
      )}
    </section>
  );
}
