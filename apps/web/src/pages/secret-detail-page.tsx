import { FormTextField, Loading, useConfirm } from "@blendsdk/fluentui-react-components";
import { Button, Card, Text } from "@fluentui/react-components";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate, useParams } from "react-router";
import { DataTable } from "../components/data-table.js";
import { AsyncPanel, EmptyState, ErrorAlert } from "../components/feedback.js";
import { NavButton } from "../components/nav-button.js";
import { PageHeader } from "../components/page-header.js";
import { formatTags, formatTime, StatusBadge } from "../components/status.js";
import type { OpenVaultWebClient } from "../generated/index.js";
import { useAsync } from "../hooks/use-async.js";
import { useProject } from "../projects/project-route.js";
import { useSessionApi } from "../session/session-api-provider.js";

type SecretMetadata = Awaited<
  ReturnType<OpenVaultWebClient["secrets"]["listSecrets"]>
>["secrets"][number];

const REVEAL_SECONDS = 60;

interface VersionValues {
  value: string;
}

/** Secret detail with audited reveal, versions, consumers, and actions. */
export function SecretDetailPage() {
  const { project } = useProject();
  const { name = "" } = useParams();
  const { client } = useSessionApi();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [revealed, setRevealed] = useState<
    { readonly value: string; readonly encoding: "utf8" | "base64" } | undefined
  >(undefined);
  const [secondsLeft, setSecondsLeft] = useState(REVEAL_SECONDS);
  const [revealFailure, setRevealFailure] = useState<unknown>(undefined);
  const [actionFailure, setActionFailure] = useState<unknown>(undefined);
  const [versionOpen, setVersionOpen] = useState(false);
  const [deletedMetadata, setDeletedMetadata] = useState<SecretMetadata | undefined>(undefined);
  const [copyStatus, setCopyStatus] = useState<string | undefined>(undefined);
  const revealRegion = useRef<HTMLDivElement>(null);
  const revealedInput = useRef<HTMLTextAreaElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const versionForm = useForm<VersionValues>({ defaultValues: { value: "" } });

  const metadata = useAsync(
    async (signal) => {
      const page = await client.secrets.listSecrets(
        { project: project.name, q: name, limit: 100 },
        { signal },
      );
      return page.secrets.find((secret) => secret.name === name);
    },
    [client, project.name, name],
  );

  const secret = deletedMetadata ?? metadata.data;
  const versions = useAsync(
    async (signal) =>
      await client.secrets.listSecretVersions({ project: project.name, name }, { signal }),
    [client, project.name, name],
    secret !== undefined && secret.status === "active",
  );
  const consumers = useAsync(
    async (signal) =>
      await client.secrets.listSecretConsumers({ project: project.name, name }, { signal }),
    [client, project.name, name],
    secret !== undefined && secret.status === "active",
  );

  const clearReveal = useCallback((): void => {
    setRevealed(undefined);
    setSecondsLeft(REVEAL_SECONDS);
    setCopyStatus(undefined);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (revealed !== undefined) {
      revealedInput.current?.focus();
    }
  }, [revealed]);

  useEffect(() => {
    if (revealed === undefined) {
      return;
    }
    const onWindowBlur = (): void => clearReveal();
    window.addEventListener("blur", onWindowBlur);
    const timer = setInterval(() => {
      setSecondsLeft((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      clearInterval(timer);
    };
  }, [revealed, clearReveal]);

  useEffect(() => {
    if (revealed !== undefined && secondsLeft === 0) {
      clearReveal();
    }
  }, [revealed, secondsLeft, clearReveal]);

  useEffect(() => {
    const region = revealRegion.current;
    if (region === null || revealed === undefined) {
      return;
    }
    const onBlur = (event: FocusEvent): void => {
      if (!region.contains(event.relatedTarget as Node | null)) {
        clearReveal();
      }
    };
    region.addEventListener("blur", onBlur, true);
    return () => region.removeEventListener("blur", onBlur, true);
  }, [revealed, clearReveal]);

  const reveal = async (): Promise<void> => {
    setRevealFailure(undefined);
    try {
      const response = await client.secrets.getSecret({ project: project.name, name });
      setRevealed({ value: response.value, encoding: response.encoding });
      setSecondsLeft(REVEAL_SECONDS);
    } catch (error) {
      setRevealFailure(error);
    }
  };

  const copyRevealed = (): void => {
    if (revealed === undefined || navigator.clipboard === undefined) {
      return;
    }
    void navigator.clipboard.writeText(revealed.value).then(
      () => {
        setCopyStatus("Copied. The clipboard will be cleared in 30 seconds if the browser allows.");
        if (copyTimer.current !== undefined) {
          clearTimeout(copyTimer.current);
        }
        copyTimer.current = setTimeout(() => {
          if (navigator.clipboard === undefined) {
            return;
          }
          if (!document.hasFocus()) {
            if (alive.current) {
              setCopyStatus(
                "Clipboard clear was skipped because the page was not focused; copy again or clear it manually.",
              );
            }
            return;
          }
          void navigator.clipboard.writeText("").then(
            () => {
              if (alive.current) {
                setCopyStatus("Clipboard cleared.");
              }
            },
            () => {
              if (alive.current) {
                setCopyStatus(
                  "Copied value remains on the clipboard; the browser blocked clearing.",
                );
              }
            },
          );
        }, 30_000);
      },
      () => setCopyStatus("The browser blocked clipboard access."),
    );
  };

  const submitVersion = versionForm.handleSubmit(async (values) => {
    if (values.value.length === 0) {
      versionForm.setError("value", { message: "Enter a value" });
      return;
    }
    setActionFailure(undefined);
    try {
      await client.secrets.writeSecretValue({
        project: project.name,
        name,
        value: values.value,
      });
      versionForm.reset({ value: "" });
      setVersionOpen(false);
      metadata.reload();
      versions.reload();
    } catch (error) {
      setActionFailure(error);
    }
  });

  const remove = async (): Promise<void> => {
    const confirmed = await confirm({
      title: `Delete secret ${name}?`,
      message: "The secret is soft-deleted and can be recovered until its purge deadline.",
      intent: "danger",
    });
    if (!confirmed || secret === undefined) {
      return;
    }
    setActionFailure(undefined);
    try {
      await client.secrets.deleteSecret({ project: project.name, name });
      setDeletedMetadata({ ...secret, status: "deleted" });
      clearReveal();
    } catch (error) {
      setActionFailure(error);
    }
  };

  const recover = async (): Promise<void> => {
    setActionFailure(undefined);
    try {
      await client.secrets.recoverSecret({ project: project.name, name });
      setDeletedMetadata(undefined);
      metadata.reload();
    } catch (error) {
      setActionFailure(error);
    }
  };

  const purge = async (): Promise<void> => {
    const confirmed = await confirm({
      title: `Permanently purge ${name}?`,
      message: "This cannot be undone. Every version and its wrapped key are removed.",
      intent: "danger",
    });
    if (!confirmed) {
      return;
    }
    setActionFailure(undefined);
    try {
      await client.secrets.purgeSecret({ project: project.name, name });
      navigate(`/projects/${encodeURIComponent(project.name)}/secrets`, { replace: true });
    } catch (error) {
      setActionFailure(error);
    }
  };

  if (metadata.loading) {
    return (
      <div className="page-loading" aria-busy="true">
        <Loading label="Loading secret…" />
      </div>
    );
  }
  if (metadata.error !== undefined) {
    return (
      <section className="page">
        <ErrorAlert error={metadata.error} onRetry={metadata.reload} />
      </section>
    );
  }
  if (secret === undefined) {
    return (
      <section className="page">
        <EmptyState
          title="Secret not found"
          action={
            <NavButton
              to={`/projects/${encodeURIComponent(project.name)}/secrets`}
              appearance="primary"
            >
              Back to secrets
            </NavButton>
          }
        >
          <p>
            No secret named <code>{name}</code> is visible in this project.
          </p>
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="page stack-lg">
      <PageHeader
        eyebrow={
          <>
            <Link to={`/projects/${encodeURIComponent(project.name)}/secrets`}>Secrets</Link>{" "}
            <span aria-hidden="true">/</span> {secret.name}
          </>
        }
        title={secret.name}
        description={
          <span className="muted">
            {secret.contentType} · updated {formatTime(secret.updatedAt)}
          </span>
        }
        actions={
          <>
            {secret.status === "deleted" ? (
              <Button appearance="secondary" onClick={() => void recover()}>
                Recover
              </Button>
            ) : null}
            {secret.capabilities.canWrite && secret.status === "active" ? (
              <Button
                appearance="primary"
                onClick={() => {
                  setActionFailure(undefined);
                  versionForm.reset({ value: "" });
                  setVersionOpen(true);
                }}
              >
                New version
              </Button>
            ) : null}
            {secret.capabilities.canDelete && secret.status === "active" ? (
              <Button appearance="subtle" onClick={() => void remove()}>
                Delete
              </Button>
            ) : null}
            {secret.capabilities.canPurge && secret.status === "deleted" ? (
              <Button appearance="subtle" onClick={() => void purge()}>
                Purge
              </Button>
            ) : null}
          </>
        }
      />

      {actionFailure === undefined ? null : <ErrorAlert error={actionFailure} />}

      <Card className="value-card">
        <div className="card-heading">
          <Text weight="semibold">Value</Text>
          <StatusBadge status={secret.status} />
        </div>
        {revealed === undefined ? (
          <div className="value-row">
            <span className="masked-value" aria-hidden="true">
              ••••••••
            </span>
            <span className="sr-only">Value is masked</span>
            {secret.capabilities.canRead ? (
              <Button appearance="primary" onClick={() => void reveal()}>
                Reveal
              </Button>
            ) : (
              <span className="muted">You do not have permission to read this value.</span>
            )}
          </div>
        ) : (
          <div className="revealed-region" ref={revealRegion}>
            <textarea
              className="revealed-value"
              ref={revealedInput}
              aria-label="Revealed secret value"
              readOnly
              value={revealed.value}
              rows={Math.min(8, Math.max(2, revealed.value.split("\n").length))}
            />
            <div className="value-actions">
              <Button appearance="secondary" onClick={copyRevealed}>
                Copy value
              </Button>
              <Button
                appearance="subtle"
                onClick={() => {
                  clearReveal();
                  document.querySelector<HTMLElement>("h1")?.focus();
                }}
              >
                Hide now
              </Button>
              <span className="muted" aria-live="polite">
                Clears in {secondsLeft}s
              </span>
            </div>
            <p className="muted">
              Encoding: {revealed.encoding}. The value is held only on this page and clears on blur,
              navigation, or after 60 seconds.
            </p>
          </div>
        )}
        {copyStatus === undefined ? null : (
          <p className="muted" role="status">
            {copyStatus}
          </p>
        )}
        {revealFailure === undefined ? null : <ErrorAlert error={revealFailure} />}
        <p className="muted">
          Revealing performs a server read and writes a <code>secret.read</code> audit event.
        </p>
      </Card>

      <div className="detail-grid">
        <Card>
          <Text weight="semibold">Metadata</Text>
          <dl className="metadata-list">
            <dt>Id</dt>
            <dd>
              <code>{secret.id}</code>
            </dd>
            <dt>Current version</dt>
            <dd>{secret.currentVersion === null ? "—" : secret.currentVersion.id}</dd>
            <dt>Created</dt>
            <dd>{formatTime(secret.createdAt)}</dd>
            <dt>Expires</dt>
            <dd>{formatTime(secret.currentVersion?.expiresAt)}</dd>
            <dt>Tags</dt>
            <dd>{formatTags(secret.tags)}</dd>
            <dt>Purge protected</dt>
            <dd>{secret.purgeProtected ? "yes" : "no"}</dd>
          </dl>
        </Card>
        <Card>
          <Text weight="semibold">Capabilities</Text>
          <ul className="capability-list">
            <li>Read: {secret.capabilities.canRead ? "allowed" : "denied"}</li>
            <li>Write: {secret.capabilities.canWrite ? "allowed" : "denied"}</li>
            <li>Delete: {secret.capabilities.canDelete ? "allowed" : "denied"}</li>
            <li>Purge: {secret.capabilities.canPurge ? "allowed" : "denied"}</li>
            <li>Manage access: {secret.capabilities.canManage ? "allowed" : "denied"}</li>
          </ul>
        </Card>
      </div>

      <Card>
        <Text weight="semibold">Versions</Text>
        <AsyncPanel loading={versions.loading} error={versions.error} onRetry={versions.reload}>
          {(versions.data?.versions.length ?? 0) === 0 ? (
            <p className="muted">No versions are visible.</p>
          ) : (
            <DataTable
              caption="Secret versions"
              rows={versions.data?.versions ?? []}
              rowKey={(version) => version.id}
              columns={[
                {
                  key: "id",
                  header: "Version",
                  render: (version) => (
                    <span>
                      <code>{version.id}</code> {version.isCurrent ? "(current)" : ""}
                    </span>
                  ),
                },
                {
                  key: "status",
                  header: "Status",
                  render: (version) => <StatusBadge status={version.status} />,
                },
                {
                  key: "created",
                  header: "Created",
                  render: (version) => formatTime(version.createdAt),
                },
                {
                  key: "expires",
                  header: "Expires",
                  render: (version) => formatTime(version.expiresAt),
                },
              ]}
            />
          )}
        </AsyncPanel>
      </Card>

      <Card>
        <Text weight="semibold">Consumers</Text>
        <AsyncPanel loading={consumers.loading} error={consumers.error} onRetry={consumers.reload}>
          {(consumers.data?.consumers.length ?? 0) === 0 ? (
            <p className="muted">No agent has consumed this secret yet.</p>
          ) : (
            <DataTable
              caption="Secret consumers"
              rows={consumers.data?.consumers ?? []}
              rowKey={(consumer) => `${consumer.composeProject}/${consumer.composeService}`}
              columns={[
                {
                  key: "project",
                  header: "Compose project",
                  render: (consumer) => consumer.composeProject,
                },
                {
                  key: "service",
                  header: "Compose service",
                  render: (consumer) => consumer.composeService,
                },
                {
                  key: "lastSeen",
                  header: "Last seen",
                  render: (consumer) => formatTime(consumer.lastSeen),
                },
              ]}
            />
          )}
        </AsyncPanel>
      </Card>

      {versionOpen ? (
        <section className="inline-panel" aria-labelledby="new-version-title">
          <h2 id="new-version-title">New version</h2>
          <form onSubmit={(event) => void submitVersion(event)} noValidate className="stack">
            <FormTextField
              control={versionForm.control}
              name="value"
              label="New value"
              type="password"
              required
              autoFocus
            />
            <div className="row-actions">
              <Button
                type="submit"
                appearance="primary"
                disabled={versionForm.formState.isSubmitting}
              >
                Write version
              </Button>
              <Button
                appearance="secondary"
                onClick={() => {
                  versionForm.reset({ value: "" });
                  setVersionOpen(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </section>
      ) : null}
    </section>
  );
}
