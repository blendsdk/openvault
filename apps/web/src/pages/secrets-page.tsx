import { FormTextareaField, FormTextField } from "@blendsdk/fluentui-react-components";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
} from "@fluentui/react-components";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { CliHint } from "../components/copy.js";
import { DataTable } from "../components/data-table.js";
import { AsyncPanel, EmptyState, ErrorAlert } from "../components/feedback.js";
import { PageHeader } from "../components/page-header.js";
import { formatTags, formatTime, StatusBadge } from "../components/status.js";
import type { OpenVaultWebClient } from "../generated/index.js";
import { useAsync } from "../hooks/use-async.js";
import { useProject } from "../projects/project-route.js";
import { useSessionApi } from "../session/session-api-provider.js";
import { parseTagLines, validateSecretName } from "../validation.js";

type SecretListItem = Awaited<
  ReturnType<OpenVaultWebClient["secrets"]["listSecrets"]>
>["secrets"][number];

interface Filters {
  q: string;
  tagKey: string;
  tagValue: string;
}

interface CreateValues {
  name: string;
  value: string;
  contentType: string;
  tags: string;
}

const EMPTY_FILTERS: Filters = { q: "", tagKey: "", tagValue: "" };

/** Secret list with search, tags, cursor pagination, and create. */
export function SecretsPage() {
  const { project } = useProject();
  const { client } = useSessionApi();
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [extra, setExtra] = useState<SecretListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const form = useForm<CreateValues>({
    defaultValues: { name: "", value: "", contentType: "text/plain", tags: "" },
  });

  const page = useAsync(
    async (signal) =>
      await client.secrets.listSecrets(
        {
          project: project.name,
          limit: 25,
          ...(filters.q.length === 0 ? {} : { q: filters.q }),
          ...(filters.tagKey.length === 0 ? {} : { tagKey: filters.tagKey }),
          ...(filters.tagValue.length === 0 ? {} : { tagValue: filters.tagValue }),
        },
        { signal },
      ),
    [client, project.name, filters.q, filters.tagKey, filters.tagValue],
  );

  useEffect(() => {
    setExtra([]);
    setNextCursor(page.data?.nextCursor ?? null);
  }, [page.data]);

  const items = [...(page.data?.secrets ?? []), ...extra];

  const loadMore = async (): Promise<void> => {
    if (nextCursor === null) {
      return;
    }
    setMoreLoading(true);
    setMoreError(undefined);
    try {
      const next = await client.secrets.listSecrets({
        project: project.name,
        limit: 25,
        cursor: nextCursor,
        ...(filters.q.length === 0 ? {} : { q: filters.q }),
        ...(filters.tagKey.length === 0 ? {} : { tagKey: filters.tagKey }),
        ...(filters.tagValue.length === 0 ? {} : { tagValue: filters.tagValue }),
      });
      setExtra((current) => [...current, ...next.secrets]);
      setNextCursor(next.nextCursor);
    } catch (error) {
      setMoreError(error);
    } finally {
      setMoreLoading(false);
    }
  };

  const closeCreate = (): void => {
    form.reset({ name: "", value: "", contentType: "text/plain", tags: "" });
    setCreateOpen(false);
  };

  const openCreate = (): void => {
    setFailure(undefined);
    form.reset({ name: "", value: "", contentType: "text/plain", tags: "" });
    setCreateOpen(true);
  };

  const submitCreate = form.handleSubmit(async (values) => {
    const nameMessage = validateSecretName(values.name);
    if (nameMessage !== undefined) {
      form.setError("name", { message: nameMessage });
      return;
    }
    if (values.value.length === 0) {
      form.setError("value", { message: "Enter a value" });
      return;
    }
    let tags: Record<string, string>;
    try {
      tags = parseTagLines(values.tags);
    } catch (error) {
      form.setError("tags", { message: error instanceof Error ? error.message : "Invalid tags" });
      return;
    }
    setFailure(undefined);
    try {
      await client.secrets.createSecret({
        project: project.name,
        name: values.name,
        value: values.value,
        contentType: values.contentType,
        tags,
      });
      closeCreate();
      page.reload();
    } catch (error) {
      setFailure(error);
    }
  });

  const base = `/projects/${encodeURIComponent(project.name)}/secrets`;
  return (
    <section className="page">
      <PageHeader
        title="Secrets"
        description="Values are masked until an explicit, audited reveal."
        actions={
          <>
            <Link to={`/projects/${encodeURIComponent(project.name)}/rotation?status=due`}>
              Needs rotation
            </Link>
            <Button appearance="primary" onClick={openCreate}>
              New secret
            </Button>
          </>
        }
      />
      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters(draft);
        }}
      >
        <Field label="Search" className="filter-field">
          <Input
            value={draft.q}
            onChange={(_event, data) => setDraft({ ...draft, q: data.value })}
            placeholder="Secret name"
          />
        </Field>
        <Field label="Tag key" className="filter-field">
          <Input
            value={draft.tagKey}
            onChange={(_event, data) => setDraft({ ...draft, tagKey: data.value })}
            placeholder="env"
          />
        </Field>
        <Field label="Tag value" className="filter-field">
          <Input
            value={draft.tagValue}
            onChange={(_event, data) => setDraft({ ...draft, tagValue: data.value })}
            placeholder="prod"
          />
        </Field>
        <div className="filter-actions">
          <Button type="submit">Apply filters</Button>
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

      {failure === undefined ? null : <ErrorAlert error={failure} />}
      <AsyncPanel
        loading={page.loading}
        error={page.error}
        onRetry={page.reload}
        loadingLabel="Loading secrets…"
      >
        {items.length === 0 ? (
          <EmptyState
            title="No secrets match"
            action={
              <Button appearance="primary" onClick={openCreate}>
                Create a secret
              </Button>
            }
          >
            <p>Adjust the filters or create a secret from the CLI:</p>
            <CliHint command={`ov secret set <name> --project ${project.name} --stdin`} />
          </EmptyState>
        ) : (
          <>
            <DataTable
              caption="Secrets"
              rows={items}
              rowKey={(secret) => secret.id}
              busy={page.loading || moreLoading}
              columns={[
                {
                  key: "name",
                  header: "Name",
                  render: (secret) => (
                    <Link to={`${base}/${encodeURIComponent(secret.name)}`}>{secret.name}</Link>
                  ),
                },
                {
                  key: "status",
                  header: "Status",
                  render: (secret) => <StatusBadge status={secret.status} />,
                },
                {
                  key: "rotation",
                  header: "Rotation",
                  render: (secret) => {
                    if (secret.rotationIntervalDays === null) {
                      return "—";
                    }
                    const status =
                      typeof secret.rotationStatus === "string" ? secret.rotationStatus : "unknown";
                    return status === "due_soon" || status === "overdue" ? (
                      <Link
                        to={`/projects/${encodeURIComponent(project.name)}/rotation?status=due`}
                      >
                        <Badge
                          appearance="tint"
                          color={status === "overdue" ? "danger" : "warning"}
                        >
                          {status}
                        </Badge>
                      </Link>
                    ) : (
                      <Badge appearance="tint" color="success">
                        {status}
                      </Badge>
                    );
                  },
                },
                {
                  key: "version",
                  header: "Version",
                  render: (secret) =>
                    secret.currentVersion === null ? "—" : secret.currentVersion.id.slice(-6),
                },
                { key: "tags", header: "Tags", render: (secret) => formatTags(secret.tags) },
                {
                  key: "updated",
                  header: "Updated",
                  render: (secret) => formatTime(secret.updatedAt),
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

      <Dialog
        open={createOpen}
        onOpenChange={(_event, data) => {
          if (!data.open) {
            closeCreate();
          }
        }}
        modalType="modal"
      >
        <DialogSurface>
          <form onSubmit={(event) => void submitCreate(event)} noValidate>
            <DialogBody>
              <DialogTitle>New secret</DialogTitle>
              <DialogContent className="stack">
                {failure === undefined ? null : <ErrorAlert error={failure} />}
                <FormTextField
                  control={form.control}
                  name="name"
                  label="Secret name"
                  hint="Letters, digits, and hyphens"
                  required
                  autoFocus
                />
                <FormTextField
                  control={form.control}
                  name="value"
                  label="Value"
                  type="password"
                  hint="Sent once; cleared from the form on close"
                  required
                />
                <FormTextField
                  control={form.control}
                  name="contentType"
                  label="Content type"
                  hint="text/plain, application/json, or another media type"
                />
                <FormTextareaField
                  control={form.control}
                  name="tags"
                  label="Tags"
                  hint="One key=value per line"
                />
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={closeCreate}>
                  Cancel
                </Button>
                <Button type="submit" appearance="primary" disabled={form.formState.isSubmitting}>
                  Create secret
                </Button>
              </DialogActions>
            </DialogBody>
          </form>
        </DialogSurface>
      </Dialog>
    </section>
  );
}
