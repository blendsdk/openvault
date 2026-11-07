import { FormTextField, useConfirm } from "@blendsdk/fluentui-react-components";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from "@fluentui/react-components";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { CliHint, CopyButton } from "../components/copy.js";
import { subscribeCredentialCopy } from "../components/credential-copy.js";
import { DataTable } from "../components/data-table.js";
import { AsyncPanel, EmptyState, ErrorAlert } from "../components/feedback.js";
import { PageHeader } from "../components/page-header.js";
import { formatTime, StatusBadge } from "../components/status.js";
import type { OpenVaultWebClient } from "../generated/index.js";
import { useAsync } from "../hooks/use-async.js";
import { useProject } from "../projects/project-route.js";
import { useSessionApi } from "../session/session-api-provider.js";

type Identity = Awaited<
  ReturnType<OpenVaultWebClient["identities"]["listIdentities"]>
>["identities"][number];

interface IdentityValues {
  name: string;
}

/** Service identities with create, revoke, and one-time join tokens. */
export function IdentitiesPage() {
  const { project } = useProject();
  const { client } = useSessionApi();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [joinToken, setJoinToken] = useState<
    { readonly identity: Identity; readonly token: string; readonly expiresAt: string } | undefined
  >(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [clipboardStatus, setClipboardStatus] = useState<string | undefined>(undefined);
  const form = useForm<IdentityValues>({ defaultValues: { name: "" } });
  const identities = useAsync(
    async (signal) => await client.identities.listIdentities({ projectId: project.id }, { signal }),
    [client, project.id],
  );

  useEffect(() => subscribeCredentialCopy((result) => setClipboardStatus(result.message)), []);

  const openCreate = (): void => {
    setFailure(undefined);
    form.reset({ name: "" });
    setCreateOpen(true);
  };

  const submitCreate = form.handleSubmit(async (values) => {
    if (values.name.trim().length === 0) {
      form.setError("name", { message: "Enter an identity name" });
      return;
    }
    setFailure(undefined);
    try {
      await client.identities.createIdentity({
        name: values.name.trim(),
        projectId: project.id,
      });
      setCreateOpen(false);
      identities.reload();
    } catch (error) {
      setFailure(error);
    }
  });

  const revoke = async (identity: Identity): Promise<void> => {
    const confirmed = await confirm({
      title: `Revoke ${identity.name}?`,
      message: "The identity is disabled and its certificates and join tokens are revoked.",
      intent: "danger",
    });
    if (!confirmed) {
      return;
    }
    setFailure(undefined);
    try {
      await client.identities.revokeIdentity({ id: identity.id });
      identities.reload();
    } catch (error) {
      setFailure(error);
    }
  };

  const issueToken = async (identity: Identity): Promise<void> => {
    setFailure(undefined);
    try {
      const response = await client.identities.issueJoinToken({ id: identity.id });
      setJoinToken({ identity, token: response.token, expiresAt: response.expiresAt });
    } catch (error) {
      setFailure(error);
    }
  };

  return (
    <section className="page">
      <PageHeader
        title="Identities"
        description="Service principals use mTLS certificates and one-time join tokens."
        actions={
          <Button appearance="primary" onClick={openCreate}>
            New identity
          </Button>
        }
      />
      {failure === undefined ? null : <ErrorAlert error={failure} />}
      <AsyncPanel
        loading={identities.loading}
        error={identities.error}
        onRetry={identities.reload}
        loadingLabel="Loading identities…"
      >
        {(identities.data?.identities.length ?? 0) === 0 ? (
          <EmptyState
            title="No service identities"
            action={
              <Button appearance="primary" onClick={openCreate}>
                Create an identity
              </Button>
            }
          >
            <p>Create one here or from the CLI:</p>
            <CliHint command={`ov identity create api --project ${project.name}`} />
          </EmptyState>
        ) : (
          <DataTable
            caption="Service identities"
            rows={identities.data?.identities ?? []}
            rowKey={(identity) => identity.id}
            columns={[
              { key: "name", header: "Name", render: (identity) => identity.name },
              {
                key: "status",
                header: "Status",
                render: (identity) => <StatusBadge status={identity.status} />,
              },
              {
                key: "created",
                header: "Created",
                render: (identity) => formatTime(identity.createdAt),
              },
              {
                key: "actions",
                header: "Actions",
                render: (identity) => (
                  <div className="row-actions">
                    <Button
                      size="small"
                      appearance="subtle"
                      onClick={() => void issueToken(identity)}
                    >
                      Join token
                    </Button>
                    <Button size="small" appearance="subtle" onClick={() => void revoke(identity)}>
                      Revoke
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </AsyncPanel>

      <Dialog
        open={createOpen}
        onOpenChange={(_event, data) => setCreateOpen(data.open)}
        modalType="modal"
      >
        <DialogSurface>
          <form onSubmit={(event) => void submitCreate(event)} noValidate>
            <DialogBody>
              <DialogTitle>New service identity</DialogTitle>
              <DialogContent className="stack">
                {failure === undefined ? null : <ErrorAlert error={failure} />}
                <FormTextField
                  control={form.control}
                  name="name"
                  label="Identity name"
                  hint="For example, payments-api"
                  required
                  autoFocus
                />
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" appearance="primary" disabled={form.formState.isSubmitting}>
                  Create identity
                </Button>
              </DialogActions>
            </DialogBody>
          </form>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={joinToken !== undefined}
        onOpenChange={(_event, data) => {
          if (!data.open) {
            setJoinToken(undefined);
          }
        }}
        modalType="modal"
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Join token for {joinToken?.identity.name}</DialogTitle>
            <DialogContent className="stack">
              <p className="warning-text">
                This token is shown once. Store it securely and pass it to the agent.
              </p>
              {joinToken === undefined ? null : (
                <>
                  <code className="join-token">{joinToken.token}</code>
                  <div className="row-actions">
                    <CopyButton
                      value={joinToken.token}
                      label="Copy token"
                      copiedLabel="Token copied"
                      credential
                    />
                  </div>
                  <p className="muted">Expires {formatTime(joinToken.expiresAt)}.</p>
                </>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setJoinToken(undefined)}>
                Done
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      {clipboardStatus === undefined ? null : (
        <p className="muted" role="status">
          {clipboardStatus}
        </p>
      )}
    </section>
  );
}
