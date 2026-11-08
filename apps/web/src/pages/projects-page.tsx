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
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { CliHint } from "../components/copy.js";
import { DataTable } from "../components/data-table.js";
import { AsyncPanel, EmptyState, ErrorAlert } from "../components/feedback.js";
import { PageHeader } from "../components/page-header.js";
import { formatTime } from "../components/status.js";
import { useAsync } from "../hooks/use-async.js";
import type { ProjectListItem } from "../projects/project-route.js";
import { useSessionApi } from "../session/session-api-provider.js";
import { validateProjectName } from "../validation.js";

interface NameValues {
  name: string;
}

/** Project list with create, rename, and delete. */
export function ProjectsPage() {
  const { client } = useSessionApi();
  const confirm = useConfirm();
  const projects = useAsync(
    async (signal) => await client.projects.listProjects({ signal }),
    [client],
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ProjectListItem | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const createForm = useForm<NameValues>({ defaultValues: { name: "" } });
  const renameForm = useForm<NameValues>({ defaultValues: { name: "" } });

  const openCreate = (): void => {
    setFailure(undefined);
    createForm.reset({ name: "" });
    setCreateOpen(true);
  };

  const openRename = (project: ProjectListItem): void => {
    setFailure(undefined);
    renameForm.reset({ name: project.name });
    setRenameTarget(project);
  };

  const submitCreate = createForm.handleSubmit(async (values) => {
    const message = validateProjectName(values.name);
    if (message !== undefined) {
      createForm.setError("name", { message });
      return;
    }
    setFailure(undefined);
    try {
      await client.projects.createProject({ name: values.name });
      setCreateOpen(false);
      projects.reload();
    } catch (error) {
      setFailure(error);
    }
  });

  const submitRename = renameForm.handleSubmit(async (values) => {
    if (renameTarget === undefined) {
      return;
    }
    const message = validateProjectName(values.name);
    if (message !== undefined) {
      renameForm.setError("name", { message });
      return;
    }
    setFailure(undefined);
    try {
      await client.projects.updateProject({ project: renameTarget.id, name: values.name });
      setRenameTarget(undefined);
      projects.reload();
    } catch (error) {
      setFailure(error);
    }
  });

  const remove = async (project: ProjectListItem): Promise<void> => {
    const confirmed = await confirm({
      title: `Delete project ${project.name}?`,
      message:
        "The project and its secrets become hidden. v1.0 has no project recovery; the data can only be restored from a backup.",
      intent: "danger",
    });
    if (!confirmed) {
      return;
    }
    setFailure(undefined);
    try {
      await client.projects.deleteProject({ project: project.id });
      projects.reload();
    } catch (error) {
      setFailure(error);
    }
  };

  return (
    <section className="page">
      <PageHeader
        title="Projects"
        description="Each project groups secrets, service identities, roles, and audit events."
        actions={
          <Button appearance="primary" onClick={openCreate}>
            New project
          </Button>
        }
      />
      {failure === undefined ? null : <ErrorAlert error={failure} />}
      <AsyncPanel
        loading={projects.loading}
        error={projects.error}
        onRetry={projects.reload}
        loadingLabel="Loading projects…"
      >
        {(projects.data?.projects.length ?? 0) === 0 ? (
          <EmptyState
            title="No projects yet"
            action={
              <Button appearance="primary" onClick={openCreate}>
                Create the first project
              </Button>
            }
          >
            <p>Create a project here or with the CLI:</p>
            <CliHint command="ov project create payments" />
          </EmptyState>
        ) : (
          <DataTable
            caption="Projects"
            rows={projects.data?.projects ?? []}
            rowKey={(project) => project.id}
            columns={[
              {
                key: "name",
                header: "Name",
                render: (project) => (
                  <Link to={`/projects/${encodeURIComponent(project.name)}`}>{project.name}</Link>
                ),
              },
              {
                key: "certificates",
                header: "Certificates",
                render: (project) => String(project.certificateCount),
              },
              {
                key: "updated",
                header: "Updated",
                render: (project) => formatTime(project.updatedAt),
              },
              {
                key: "actions",
                header: "Actions",
                render: (project) => (
                  <div className="row-actions">
                    <Button size="small" appearance="subtle" onClick={() => openRename(project)}>
                      Rename
                    </Button>
                    <Button size="small" appearance="subtle" onClick={() => void remove(project)}>
                      Delete
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
              <DialogTitle>New project</DialogTitle>
              <DialogContent className="stack">
                {failure === undefined ? null : <ErrorAlert error={failure} />}
                <FormTextField
                  control={createForm.control}
                  name="name"
                  label="Project name"
                  hint="Lowercase letters, digits, and hyphens; 3–40 characters"
                  required
                  autoFocus
                />
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  appearance="primary"
                  disabled={createForm.formState.isSubmitting}
                >
                  Create
                </Button>
              </DialogActions>
            </DialogBody>
          </form>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={renameTarget !== undefined}
        onOpenChange={(_event, data) => {
          if (!data.open) {
            setRenameTarget(undefined);
          }
        }}
        modalType="modal"
      >
        <DialogSurface>
          <form onSubmit={(event) => void submitRename(event)} noValidate>
            <DialogBody>
              <DialogTitle>Rename project</DialogTitle>
              <DialogContent className="stack">
                {failure === undefined ? null : <ErrorAlert error={failure} />}
                <FormTextField
                  control={renameForm.control}
                  name="name"
                  label="Project name"
                  required
                  autoFocus
                />
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setRenameTarget(undefined)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  appearance="primary"
                  disabled={renameForm.formState.isSubmitting}
                >
                  Rename
                </Button>
              </DialogActions>
            </DialogBody>
          </form>
        </DialogSurface>
      </Dialog>
    </section>
  );
}
