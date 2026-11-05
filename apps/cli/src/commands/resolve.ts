import type { ProjectListItem } from "@openvault/api-contract";
import { ulidSchema } from "@openvault/api-contract";
import { CliError } from "../errors.js";
import type { OpenVaultClient } from "../generated/index.js";

/** Finds one visible project by exact name. */
export async function findProject(client: OpenVaultClient, name: string): Promise<ProjectListItem> {
  const result = await client.projects.listProjects();
  const project = result.projects.find((entry) => entry.name === name);
  if (project === undefined) {
    throw new CliError("project_not_found", "Project not found", { exitCode: 5 });
  }
  return project;
}

/** Resolves one active project name to its ULID. */
export async function projectId(client: OpenVaultClient, name: string): Promise<string> {
  return (await findProject(client, name)).id;
}

/** Resolves one identity name or ULID to its id. */
export async function identityId(
  client: OpenVaultClient,
  project: string,
  value: string,
): Promise<string> {
  if (ulidSchema.safeParse(value).success) {
    return value;
  }
  const result = await client.identities.listIdentities({ projectId: project });
  const identity = result.identities.find((entry) => entry.name === value);
  if (identity === undefined) {
    throw new CliError("identity_not_found", "Identity not found", { exitCode: 5 });
  }
  return identity.id;
}

/** Finds a secret id by exact name, following pages. */
export async function secretId(
  client: OpenVaultClient,
  project: string,
  name: string,
): Promise<string> {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await client.secrets.listSecrets({
      project,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const found = result.secrets.find((secret) => secret.name === name);
    if (found !== undefined) {
      return found.id;
    }
    if (result.nextCursor === null) {
      break;
    }
    cursor = result.nextCursor;
  }
  throw new CliError("not_found", "Secret not found", { exitCode: 5 });
}

/** Finds a certificate id by exact name, following pages. */
export async function certificateId(
  client: OpenVaultClient,
  project: string,
  name: string,
): Promise<string> {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await client.certificates.listCertificates({
      project,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const found = result.certificates.find((certificate) => certificate.name === name);
    if (found !== undefined) {
      return found.id;
    }
    if (result.nextCursor === null) {
      break;
    }
    cursor = result.nextCursor;
  }
  throw new CliError("not_found", "Certificate not found", { exitCode: 5 });
}
