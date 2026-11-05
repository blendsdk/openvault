import { useConfirm } from "@blendsdk/fluentui-react-components";
import { Button, Card, Dropdown, Field, Input, Option, Text } from "@fluentui/react-components";
import { useState } from "react";
import { DataTable } from "../components/data-table.js";
import { AsyncPanel, EmptyState, ErrorAlert } from "../components/feedback.js";
import { PageHeader } from "../components/page-header.js";
import { formatTime } from "../components/status.js";
import type { OpenVaultWebClient } from "../generated/index.js";
import { useAsync } from "../hooks/use-async.js";
import { useProject } from "../projects/project-route.js";
import { useSessionApi } from "../session/session-api-provider.js";

type RoleCatalog = Awaited<ReturnType<OpenVaultWebClient["meta"]["getRoleCatalog"]>>;
type Assignment = Awaited<
  ReturnType<OpenVaultWebClient["assignments"]["listAssignments"]>
>["assignments"][number];

type TargetType = "project" | "secret";

/** Access explanation and assignment editor. */
export function PermissionsPage() {
  const { project } = useProject();
  const { client } = useSessionApi();
  const confirm = useConfirm();
  const [targetType, setTargetType] = useState<TargetType>("project");
  const [secretId, setSecretId] = useState<string>("");
  const [explainAction, setExplainAction] = useState<string>("project.read");
  const [explainFailure, setExplainFailure] = useState<unknown>(undefined);
  const [explainResult, setExplainResult] = useState<
    Awaited<ReturnType<OpenVaultWebClient["access"]["explainAccess"]>> | undefined
  >(undefined);
  const [explaining, setExplaining] = useState(false);

  const [principalId, setPrincipalId] = useState("");
  const [role, setRole] = useState("");
  const [scopeType, setScopeType] = useState<"project" | "object">("project");
  const [objectId, setObjectId] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [assignmentFailure, setAssignmentFailure] = useState<unknown>(undefined);
  const [assignmentMessage, setAssignmentMessage] = useState<string | undefined>(undefined);

  const catalog = useAsync(
    async (signal) => await client.meta.getRoleCatalog({ signal }),
    [client],
  );
  const secrets = useAsync(
    async (signal) =>
      await client.secrets.listSecrets({ project: project.name, limit: 100 }, { signal }),
    [client, project.name],
  );
  const identities = useAsync(
    async (signal) => await client.identities.listIdentities({ projectId: project.id }, { signal }),
    [client, project.id],
  );
  const assignments = useAsync(
    async (signal) => await client.assignments.listAssignments({}, { signal }),
    [client, project.id],
  );

  const explain = async (): Promise<void> => {
    setExplainFailure(undefined);
    setExplaining(true);
    try {
      const result =
        targetType === "project"
          ? await client.access.explainAccess({
              action: "project.read",
              scopeType: "project",
              scopeId: project.id,
            })
          : await client.access.explainAccess({
              action: "secret.read",
              scopeType: "object",
              scopeId: secretId,
              objectType: "secret",
            });
      setExplainResult(result);
    } catch (error) {
      setExplainResult(undefined);
      setExplainFailure(error);
    } finally {
      setExplaining(false);
    }
  };

  const createAssignment = async (): Promise<void> => {
    setAssignmentFailure(undefined);
    setAssignmentMessage(undefined);
    if (principalId.trim().length === 0) {
      setAssignmentMessage("Choose or enter a principal id.");
      return;
    }
    if (role.length === 0) {
      setAssignmentMessage("Choose a role.");
      return;
    }
    if (scopeType === "object" && objectId.length === 0) {
      setAssignmentMessage("Choose the secret for an object-scope grant.");
      return;
    }
    if (expiresAt.length > 0 && Date.parse(expiresAt) <= Date.now()) {
      setAssignmentMessage("The expiry must be in the future.");
      return;
    }
    try {
      await client.assignments.createAssignment({
        principalId: principalId.trim(),
        role: role as RoleCatalog["roles"][number]["name"],
        scopeType,
        scopeId: scopeType === "project" ? project.id : objectId,
        ...(expiresAt.length === 0 ? {} : { expiresAt: new Date(expiresAt).toISOString() }),
      });
      setAssignmentMessage("Assignment created.");
      assignments.reload();
    } catch (error) {
      setAssignmentFailure(error);
    }
  };

  const remove = async (assignment: Assignment): Promise<void> => {
    const confirmed = await confirm({
      title: "Revoke this assignment?",
      message: `${assignment.role} for ${assignment.principalId}`,
      intent: "danger",
    });
    if (!confirmed) {
      return;
    }
    try {
      await client.assignments.deleteAssignment({ id: assignment.id });
      assignments.reload();
    } catch (error) {
      setAssignmentFailure(error);
    }
  };

  const secretNames = new Map(
    (secrets.data?.secrets ?? []).map((secret) => [secret.id, secret.name] as const),
  );
  const relevantAssignments = (assignments.data?.assignments ?? []).filter(
    (assignment) =>
      (assignment.scopeType === "project" && assignment.scopeId === project.id) ||
      (assignment.scopeType === "object" && secretNames.has(assignment.scopeId)),
  );
  const roleNames =
    catalog.data?.roles
      .filter((entry) => {
        if (!entry.scopes.includes(scopeType === "project" ? "project" : "object")) {
          return false;
        }
        return (
          scopeType === "project" || entry.actions.some((action) => action.startsWith("secret."))
        );
      })
      .map((entry) => entry.name) ?? [];
  const supportError = catalog.error ?? secrets.error ?? identities.error;
  const supportLoading = catalog.loading || secrets.loading || identities.loading;
  return (
    <section className="page stack-lg">
      <PageHeader
        title="Permissions"
        description="Explain effective access and manage scoped role assignments."
      />

      <Card>
        <div className="card-heading">
          <Text weight="semibold">Explain access</Text>
        </div>
        <div className="filter-bar">
          <Field label="Target type">
            <Dropdown
              value={targetType === "project" ? "Project" : "Secret"}
              selectedOptions={[targetType]}
              onOptionSelect={(_event, data) => {
                const next = data.optionValue === "secret" ? "secret" : "project";
                setTargetType(next);
                setExplainAction(next === "project" ? "project.read" : "secret.read");
                setExplainResult(undefined);
              }}
            >
              <Option value="project">Project</Option>
              <Option value="secret">Secret</Option>
            </Dropdown>
          </Field>
          {targetType === "secret" ? (
            <Field label="Secret" required>
              <Dropdown
                value={secrets.data?.secrets.find((secret) => secret.id === secretId)?.name ?? ""}
                selectedOptions={secretId.length === 0 ? [] : [secretId]}
                onOptionSelect={(_event, data) => {
                  setSecretId(data.optionValue ?? "");
                  setExplainResult(undefined);
                }}
              >
                {(secrets.data?.secrets ?? []).map((secret) => (
                  <Option key={secret.id} value={secret.id}>
                    {secret.name}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          ) : null}
          <Field label="Action">
            <Dropdown
              value={explainAction}
              selectedOptions={[explainAction]}
              onOptionSelect={(_event, data) => {
                setExplainAction(data.optionValue ?? "project.read");
                setExplainResult(undefined);
              }}
            >
              {targetType === "project" ? (
                <Option value="project.read">project.read</Option>
              ) : (
                <Option value="secret.read">secret.read</Option>
              )}
            </Dropdown>
          </Field>
          <div className="filter-actions">
            <Button
              appearance="primary"
              onClick={() => void explain()}
              disabled={explaining || (targetType === "secret" && secretId.length === 0)}
            >
              {explaining ? "Explaining…" : "Explain"}
            </Button>
          </div>
        </div>
        {explainFailure === undefined ? null : <ErrorAlert error={explainFailure} />}
        {explainResult === undefined ? null : (
          <DataTable
            caption="Effective access"
            rows={explainResult.principals}
            rowKey={(entry) => entry.assignmentId}
            emptyMessage="No principal has this action through a matching assignment."
            columns={[
              { key: "name", header: "Principal", render: (entry) => entry.name },
              { key: "kind", header: "Kind", render: (entry) => entry.kind },
              { key: "role", header: "Role", render: (entry) => entry.role },
              {
                key: "scope",
                header: "Scope",
                render: (entry) => `${entry.scopeType}: ${entry.scopeId}`,
              },
              {
                key: "consumer",
                header: "Consumer",
                render: (entry) =>
                  entry.consumer === null
                    ? "—"
                    : `${entry.consumer.composeProject}/${entry.consumer.composeService}`,
              },
            ]}
          />
        )}
        {explainResult === undefined ? null : (
          <p className="muted">Policy version {explainResult.policyVersion}.</p>
        )}
      </Card>

      <Card>
        <div className="card-heading">
          <Text weight="semibold">Project-scope assignments</Text>
        </div>
        <AsyncPanel
          loading={assignments.loading}
          error={assignments.error}
          onRetry={assignments.reload}
        >
          {relevantAssignments.length === 0 ? (
            <EmptyState title="No assignments">
              <p>Grant a role to a service identity or user principal below.</p>
            </EmptyState>
          ) : (
            <DataTable
              caption="Project assignments"
              rows={relevantAssignments}
              rowKey={(assignment) => assignment.id}
              columns={[
                {
                  key: "principal",
                  header: "Principal",
                  render: (assignment) => <code>{assignment.principalId}</code>,
                },
                { key: "role", header: "Role", render: (assignment) => assignment.role },
                {
                  key: "scope",
                  header: "Scope",
                  render: (assignment) =>
                    assignment.scopeType === "object"
                      ? `object: ${secretNames.get(assignment.scopeId) ?? assignment.scopeId}`
                      : `${assignment.scopeType}: ${assignment.scopeId}`,
                },
                {
                  key: "expires",
                  header: "Expires",
                  render: (assignment) => formatTime(assignment.expiresAt),
                },
                {
                  key: "actions",
                  header: "Actions",
                  render: (assignment) => (
                    <Button
                      size="small"
                      appearance="subtle"
                      onClick={() => void remove(assignment)}
                    >
                      Revoke
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </AsyncPanel>

        <div className="assignment-form">
          <h3>Grant a role</h3>
          {assignmentFailure === undefined ? null : <ErrorAlert error={assignmentFailure} />}
          {assignmentMessage === undefined ? null : (
            <p role="status" className="muted">
              {assignmentMessage}
            </p>
          )}
          {supportError === undefined ? null : (
            <ErrorAlert
              error={supportError}
              onRetry={() => {
                catalog.reload();
                secrets.reload();
                identities.reload();
              }}
            />
          )}
          <Field label="Service identity">
            <Dropdown
              value={
                identities.data?.identities.find((identity) => identity.id === principalId)?.name ??
                ""
              }
              selectedOptions={principalId.length === 0 ? [] : [principalId]}
              onOptionSelect={(_event, data) => setPrincipalId(data.optionValue ?? "")}
            >
              {(identities.data?.identities ?? []).map((identity) => (
                <Option key={identity.id} value={identity.id}>
                  {identity.name}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="Principal ULID" hint="A user or service principal id" required>
            <Input value={principalId} onChange={(_event, data) => setPrincipalId(data.value)} />
          </Field>
          <Field label="Role" required>
            <Dropdown
              value={role}
              selectedOptions={role.length === 0 ? [] : [role]}
              onOptionSelect={(_event, data) => setRole(data.optionValue ?? "")}
            >
              {roleNames.map((name) => (
                <Option key={name} value={name}>
                  {name}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="Scope">
            <Dropdown
              value={scopeType === "project" ? "Project" : "Object"}
              selectedOptions={[scopeType]}
              onOptionSelect={(_event, data) => {
                setScopeType(data.optionValue === "object" ? "object" : "project");
                setObjectId("");
                setRole("");
              }}
            >
              <Option value="project">Project</Option>
              <Option value="object">Secret object</Option>
            </Dropdown>
          </Field>
          {scopeType === "object" ? (
            <Field label="Secret object" required>
              <Dropdown
                value={secrets.data?.secrets.find((secret) => secret.id === objectId)?.name ?? ""}
                selectedOptions={objectId.length === 0 ? [] : [objectId]}
                onOptionSelect={(_event, data) => setObjectId(data.optionValue ?? "")}
              >
                {(secrets.data?.secrets ?? []).map((secret) => (
                  <Option key={secret.id} value={secret.id}>
                    {secret.name}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          ) : null}
          <Field label="Expiry" hint="Optional; local time">
            <Input
              type="datetime-local"
              value={expiresAt}
              onChange={(_event, data) => setExpiresAt(data.value)}
            />
          </Field>
          <Button
            appearance="primary"
            onClick={() => void createAssignment()}
            disabled={supportLoading || catalog.error !== undefined}
          >
            Grant role
          </Button>
        </div>
      </Card>
    </section>
  );
}
