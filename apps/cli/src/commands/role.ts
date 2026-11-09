import { RBAC_ROLES, type RbacRole, type RbacScopeType, ulidSchema } from "@openvault/api-contract";
import { CommandLineParser } from "blendsdk/cmdline";
import { CliError } from "../errors.js";
import type { OpenVaultClient } from "../generated/index.js";
import { formatTable, formatTime } from "../output.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext } from "./context.js";
import { requiredText, textOption } from "./options.js";
import { certificateId, identityId, projectId, secretId } from "./resolve.js";

/** Parses one role. */
function isRole(value: string): value is RbacRole {
  return RBAC_ROLES.some((role) => role === value);
}

function roleOption(value: string): RbacRole {
  if (isRole(value)) {
    return value;
  }
  throw new CliError("usage_error", `Unknown role: ${value}`, { exitCode: 2 });
}

/** Parses one scope type. */
function scopeOption(value: string | undefined): RbacScopeType {
  if (value === undefined) {
    return "project";
  }
  if (value === "org" || value === "project" || value === "object") {
    return value;
  }
  throw new CliError("usage_error", `Unknown scope: ${value}`, { exitCode: 2 });
}

/** Resolves the scope id for a grant or revoke. */
async function resolveScope(
  client: OpenVaultClient,
  projectName: string,
  scopeType: RbacScopeType,
  scopeId: string | undefined,
  objectType: string | undefined,
  objectName: string | undefined,
): Promise<string> {
  if (scopeId !== undefined) {
    if (scopeType === "org" && scopeId === "org") {
      return "org";
    }
    if (!ulidSchema.safeParse(scopeId).success) {
      throw new CliError("usage_error", "--scope-id must be a ULID", { exitCode: 2 });
    }
    return scopeId;
  }
  if (scopeType === "org") {
    return "org";
  }
  const project = await projectId(client, projectName);
  if (scopeType === "project") {
    return project;
  }
  if (objectType === "secret" && objectName !== undefined) {
    return await secretId(client, projectName, objectName);
  }
  if (objectType === "certificate" && objectName !== undefined) {
    return await certificateId(client, projectName, objectName);
  }
  throw new CliError(
    "usage_error",
    "--scope object requires --object-type secret|certificate and --object",
    { exitCode: 2 },
  );
}

/**
 * Builds the role group parser.
 *
 * @param globals - Global options.
 * @param runtime - Process boundary.
 * @returns The configured parser.
 */
export function createRoleParser(globals: GlobalOptions, runtime: CliRuntime): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({
    name: "ov role",
    version: "1.2.0",
    strict: true,
  });

  parser.addCommand({
    name: "grant",
    description: "Grant a role assignment",
    options: [
      { name: "principal", type: "string", required: true, description: "Identity name or id" },
      { name: "role", type: "string", required: true, description: "Role name" },
      {
        name: "scope",
        type: "string",
        choices: ["org", "project", "object"],
        description: "Assignment scope",
      },
      { name: "scope-id", type: "string", description: "Explicit scope ULID" },
      {
        name: "object-type",
        type: "string",
        choices: ["secret", "certificate"],
        description: "Object type for object scope",
      },
      { name: "object", type: "string", description: "Object name for object scope" },
      { name: "expires-at", type: "string", description: "Expiry (ISO timestamp)" },
    ],
    handler: async (options) => {
      const projectName = context.project();
      const { client } = await context.client();
      const principal = await identityId(
        client,
        await projectId(client, projectName),
        requiredText(options, "principal"),
      );
      const role = roleOption(requiredText(options, "role"));
      const scopeType = scopeOption(textOption(options, "scope"));
      const expiresAt = textOption(options, "expires-at");
      const scopeId = await resolveScope(
        client,
        projectName,
        scopeType,
        textOption(options, "scope-id"),
        textOption(options, "object-type"),
        textOption(options, "object"),
      );
      const assignment = await client.assignments.createAssignment({
        principalId: principal,
        role,
        scopeType,
        scopeId,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      context.render(
        assignment,
        (value) =>
          `Granted ${value.role} to ${value.principalId} on ${value.scopeType} ${value.scopeId}`,
      );
      return undefined;
    },
  });

  parser.addCommand({
    name: "revoke",
    description: "Revoke a role assignment",
    options: [
      { name: "principal", type: "string", description: "Identity name or id" },
      { name: "role", type: "string", description: "Role name" },
      { name: "assignment", type: "string", description: "Assignment id" },
      {
        name: "scope",
        type: "string",
        choices: ["org", "project", "object"],
        description: "Assignment scope",
      },
      { name: "scope-id", type: "string", description: "Explicit scope ULID" },
      {
        name: "object-type",
        type: "string",
        choices: ["secret", "certificate"],
        description: "Object type",
      },
      { name: "object", type: "string", description: "Object name" },
    ],
    handler: async (options) => {
      const assignmentId = textOption(options, "assignment");
      const projectName = assignmentId === undefined ? context.project() : undefined;
      const { client } = await context.client();
      if (assignmentId !== undefined) {
        const list = await client.assignments.listAssignments({});
        const assignment = list.assignments.find((entry) => entry.id === assignmentId);
        if (assignment === undefined) {
          throw new CliError("not_found", "Assignment not found", { exitCode: 5 });
        }
        await context.confirm(`Revoke assignment ${assignmentId}?`);
        await client.assignments.deleteAssignment({ id: assignmentId });
        context.render({ revoked: assignmentId }, (value) => `Revoked ${value.revoked}`);
        return undefined;
      }
      if (projectName === undefined) {
        throw new CliError("usage_error", "--project is required", { exitCode: 2 });
      }
      const principal = await identityId(
        client,
        await projectId(client, projectName),
        requiredText(options, "principal"),
      );
      const role = roleOption(requiredText(options, "role"));
      const scopeType = scopeOption(textOption(options, "scope"));
      const scopeId = await resolveScope(
        client,
        projectName,
        scopeType,
        textOption(options, "scope-id"),
        textOption(options, "object-type"),
        textOption(options, "object"),
      );
      const list = await client.assignments.listAssignments({
        principalId: principal,
        role,
        scopeType,
        scopeId,
      });
      if (list.assignments.length === 0) {
        throw new CliError("not_found", "Assignment not found", { exitCode: 5 });
      }
      if (list.assignments.length > 1) {
        throw new CliError(
          "usage_error",
          `Several assignments match: ${list.assignments.map((entry) => entry.id).join(", ")}; use --assignment`,
          { exitCode: 2 },
        );
      }
      const assignment = list.assignments[0];
      if (assignment === undefined) {
        throw new CliError("not_found", "Assignment not found", { exitCode: 5 });
      }
      await context.confirm(
        `Revoke ${assignment.role} from ${assignment.principalId} on ${assignment.scopeType} ${assignment.scopeId}?`,
      );
      await client.assignments.deleteAssignment({ id: assignment.id });
      context.render({ revoked: assignment.id, assignment }, (value) =>
        formatTable(
          ["ID", "PRINCIPAL", "ROLE", "SCOPE", "CREATED"],
          [
            [
              value.assignment.id,
              value.assignment.principalId,
              value.assignment.role,
              `${value.assignment.scopeType}:${value.assignment.scopeId}`,
              formatTime(value.assignment.createdAt),
            ],
          ],
        ),
      );
      return undefined;
    },
  });

  return parser;
}

/** The role group definition. */
export const roleGroup: CommandGroup = {
  name: "role",
  summary: "Grant and revoke role assignments",
  commands: ["grant", "revoke"],
  createParser: createRoleParser,
};
