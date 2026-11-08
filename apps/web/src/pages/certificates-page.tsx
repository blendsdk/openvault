import { Button, Field, Input, Select } from "@fluentui/react-components";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { CertificateGenerateDialog } from "../components/certificate-generate-dialog.js";
import { CertificateImportDialog } from "../components/certificate-import-dialog.js";
import { DataTable } from "../components/data-table.js";
import { AsyncPanel, EmptyState, ErrorAlert } from "../components/feedback.js";
import { PageHeader } from "../components/page-header.js";
import { formatTags, formatTime, StatusBadge } from "../components/status.js";
import type { OpenVaultWebClient } from "../generated/index.js";
import { useAsync } from "../hooks/use-async.js";
import { useProject } from "../projects/project-route.js";
import { useSessionApi } from "../session/session-api-provider.js";
import { endOfDayIso, startOfDayIso } from "../validation.js";

type CertificateListItem = Awaited<
  ReturnType<OpenVaultWebClient["certificates"]["listCertificates"]>
>["certificates"][number];

interface Filters {
  readonly q: string;
  readonly san: string;
  readonly expiresBefore: string;
  readonly expiresAfter: string;
  readonly status: "active" | "deleted";
}

const EMPTY_FILTERS: Filters = {
  q: "",
  san: "",
  expiresBefore: "",
  expiresAfter: "",
  status: "active",
};

/** Formats the absolute expiry plus a relative day count. */
function expiryLabel(certificate: CertificateListItem): string {
  const days = certificate.daysToExpiry;
  const relative =
    days === 0
      ? "today"
      : days > 0
        ? `in ${days} day${days === 1 ? "" : "s"}`
        : `${Math.abs(days)} days ago`;
  return `${formatTime(certificate.notAfter)} (${relative})`;
}

/**
 * Certificate list with search, SAN, expiry, status, and cursor pagination.
 *
 * Import and Generate stay visible on the active view because the list
 * response carries no project-level write flag. The server still authorizes
 * every request, and a denial is shown inside the dialog.
 */
export function CertificatesPage() {
  const { project } = useProject();
  const { client } = useSessionApi();
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [extra, setExtra] = useState<CertificateListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(undefined);
  const [createMode, setCreateMode] = useState<"import" | "generate" | undefined>(undefined);
  const filtersRef = useRef(filters);
  const moreToken = useRef(0);
  filtersRef.current = filters;

  const page = useAsync(
    async (signal) =>
      await client.certificates.listCertificates(
        {
          project: project.name,
          limit: 25,
          status: filters.status,
          ...(filters.q.length === 0 ? {} : { q: filters.q }),
          ...(filters.san.length === 0 ? {} : { san: filters.san }),
          ...(filters.expiresAfter.length === 0
            ? {}
            : { expiresAfter: startOfDayIso(filters.expiresAfter) }),
          ...(filters.expiresBefore.length === 0
            ? {}
            : { expiresBefore: endOfDayIso(filters.expiresBefore) }),
        },
        { signal },
      ),
    [
      client,
      project.name,
      filters.q,
      filters.san,
      filters.expiresAfter,
      filters.expiresBefore,
      filters.status,
    ],
  );

  useEffect(() => {
    moreToken.current += 1;
    setExtra([]);
    setNextCursor(page.data?.nextCursor ?? null);
    setMoreLoading(false);
    setMoreError(undefined);
  }, [page.data]);

  const items = [...(page.data?.certificates ?? []), ...extra];
  const hasFilters =
    filters.q.length > 0 ||
    filters.san.length > 0 ||
    filters.expiresBefore.length > 0 ||
    filters.expiresAfter.length > 0;

  const loadMore = async (): Promise<void> => {
    if (nextCursor === null) {
      return;
    }
    const token = ++moreToken.current;
    const requestedFilters = filters;
    setMoreLoading(true);
    setMoreError(undefined);
    try {
      const next = await client.certificates.listCertificates({
        project: project.name,
        limit: 25,
        cursor: nextCursor,
        status: filters.status,
        ...(filters.q.length === 0 ? {} : { q: filters.q }),
        ...(filters.san.length === 0 ? {} : { san: filters.san }),
        ...(filters.expiresAfter.length === 0
          ? {}
          : { expiresAfter: startOfDayIso(filters.expiresAfter) }),
        ...(filters.expiresBefore.length === 0
          ? {}
          : { expiresBefore: endOfDayIso(filters.expiresBefore) }),
      });
      if (token !== moreToken.current || filtersRef.current !== requestedFilters) {
        return;
      }
      setExtra((current) => [...current, ...next.certificates]);
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

  const base = `/projects/${encodeURIComponent(project.name)}/certificates`;

  return (
    <section className="page">
      <PageHeader
        title="Certificates"
        description="Search the project certificates, inspect public material, and manage their lifecycle."
        actions={
          filters.status === "deleted" ? undefined : (
            <>
              <Button appearance="primary" onClick={() => setCreateMode("import")}>
                Import certificate
              </Button>
              <Button appearance="secondary" onClick={() => setCreateMode("generate")}>
                Generate
              </Button>
            </>
          )
        }
      />
      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault();
          moreToken.current += 1;
          setMoreError(undefined);
          setFilters(draft);
        }}
      >
        <Field label="Search" className="filter-field">
          <Input
            value={draft.q}
            onChange={(_event, data) => setDraft({ ...draft, q: data.value })}
            placeholder="Name or subject"
          />
        </Field>
        <Field label="SAN" className="filter-field">
          <Input
            value={draft.san}
            onChange={(_event, data) => setDraft({ ...draft, san: data.value })}
            placeholder="DNS:api.example.com"
          />
        </Field>
        <Field label="Expires after" className="filter-field">
          <Input
            type="date"
            value={draft.expiresAfter}
            onChange={(_event, data) => setDraft({ ...draft, expiresAfter: data.value })}
          />
        </Field>
        <Field label="Expires before" className="filter-field">
          <Input
            type="date"
            value={draft.expiresBefore}
            onChange={(_event, data) => setDraft({ ...draft, expiresBefore: data.value })}
          />
        </Field>
        <Field label="Status" className="filter-field">
          <Select
            value={draft.status}
            onChange={(event) =>
              setDraft({ ...draft, status: event.target.value as Filters["status"] })
            }
          >
            <option value="active">Active</option>
            <option value="deleted">Deleted</option>
          </Select>
        </Field>
        <div className="filter-actions">
          <Button type="submit">Apply filters</Button>
          <Button
            type="button"
            appearance="subtle"
            onClick={() => {
              moreToken.current += 1;
              setMoreError(undefined);
              setDraft(EMPTY_FILTERS);
              setFilters(EMPTY_FILTERS);
            }}
          >
            Clear
          </Button>
        </div>
      </form>

      <AsyncPanel
        loading={page.loading}
        error={page.error}
        onRetry={page.reload}
        loadingLabel="Loading certificates…"
      >
        {items.length === 0 ? (
          filters.status === "deleted" ? (
            <EmptyState
              title="No deleted certificates"
              action={
                <Button
                  appearance="primary"
                  onClick={() => {
                    setDraft(EMPTY_FILTERS);
                    setFilters(EMPTY_FILTERS);
                  }}
                >
                  Back to active
                </Button>
              }
            >
              <p>Deleted certificates stay recoverable until their purge deadline.</p>
            </EmptyState>
          ) : hasFilters ? (
            <EmptyState
              title="No certificates match"
              action={
                <Button
                  appearance="primary"
                  onClick={() => {
                    setDraft(EMPTY_FILTERS);
                    setFilters(EMPTY_FILTERS);
                  }}
                >
                  Clear filters
                </Button>
              }
            >
              <p>Adjust the search, SAN, expiry, or status filter.</p>
            </EmptyState>
          ) : (
            <EmptyState
              title="No certificates yet"
              action={
                <>
                  <Button appearance="primary" onClick={() => setCreateMode("import")}>
                    Import certificate
                  </Button>
                  <Button appearance="secondary" onClick={() => setCreateMode("generate")}>
                    Generate
                  </Button>
                </>
              }
            >
              <p>Import an existing certificate or generate a self-signed one.</p>
            </EmptyState>
          )
        ) : (
          <>
            <DataTable
              caption="Certificates"
              rows={items}
              rowKey={(certificate) => certificate.id}
              busy={page.loading || moreLoading}
              columns={[
                {
                  key: "name",
                  header: "Name",
                  render: (certificate) => (
                    <Link
                      to={`${base}/${encodeURIComponent(certificate.name)}?status=${filters.status}`}
                    >
                      {certificate.name}
                    </Link>
                  ),
                },
                {
                  key: "status",
                  header: "Status",
                  render: (certificate) => <StatusBadge status={certificate.status} />,
                },
                {
                  key: "subject",
                  header: "Subject",
                  render: (certificate) => certificate.subject,
                },
                {
                  key: "expires",
                  header: "Expires",
                  render: (certificate) => expiryLabel(certificate),
                },
                {
                  key: "tags",
                  header: "Tags",
                  render: (certificate) => formatTags(certificate.tags),
                },
              ]}
            />
            {moreError === undefined ? null : (
              <ErrorAlert error={moreError} onRetry={() => void loadMore()} />
            )}
            {nextCursor === null ? null : (
              <Button appearance="secondary" onClick={() => void loadMore()} disabled={moreLoading}>
                {moreLoading ? "Loading…" : "Load more"}
              </Button>
            )}
          </>
        )}
      </AsyncPanel>

      <CertificateImportDialog
        open={createMode === "import"}
        project={project.name}
        onClose={() => setCreateMode(undefined)}
        onSaved={page.reload}
      />
      <CertificateGenerateDialog
        open={createMode === "generate"}
        project={project.name}
        onClose={() => setCreateMode(undefined)}
        onSaved={page.reload}
      />
    </section>
  );
}
