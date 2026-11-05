import { CommandLineParser } from "blendsdk/cmdline";
import { formatTable, formatTime } from "../output.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext } from "./context.js";
import { numberOption, requiredText } from "./options.js";
import { identityId, projectId } from "./resolve.js";

/**
 * Builds the identity group parser.
 *
 * @param globals - Global options.
 * @param runtime - Process boundary.
 * @returns The configured parser.
 */
export function createIdentityParser(
  globals: GlobalOptions,
  runtime: CliRuntime,
): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({
    name: "ov identity",
    version: "0.1.0",
    strict: true,
  });

  parser.addCommand({
    name: "create",
    description: "Create a service identity",
    options: [{ name: "name", type: "string", required: true, description: "Identity name" }],
    handler: async (options) => {
      const projectName = context.project();
      const { client } = await context.client();
      const project = await projectId(client, projectName);
      const identity = await client.identities.createIdentity({
        name: requiredText(options, "name"),
        projectId: project,
      });
      context.render(identity, (value) => `Created identity ${value.name} (${value.id})`);
      return undefined;
    },
  });

  parser.addCommand({
    name: "list",
    description: "List service identities in a project",
    handler: async () => {
      const projectName = context.project();
      const { client } = await context.client();
      const project = await projectId(client, projectName);
      const result = await client.identities.listIdentities({ projectId: project });
      context.render(result, (value) =>
        formatTable(
          ["NAME", "ID", "STATUS", "CREATED"],
          value.identities.map((identity) => [
            identity.name,
            identity.id,
            identity.status,
            formatTime(identity.createdAt),
          ]),
        ),
      );
      return undefined;
    },
  });

  parser.addCommand({
    name: "revoke",
    description: "Revoke a service identity by name or id",
    options: [{ name: "name", type: "string", required: true, description: "Identity name or id" }],
    handler: async (options) => {
      const value = requiredText(options, "name");
      const projectName = context.project();
      const { client } = await context.client();
      const project = await projectId(client, projectName);
      const id = await identityId(client, project, value);
      await context.confirm(`Revoke identity ${value}?`);
      await client.identities.revokeIdentity({ id });
      context.render({ revoked: id }, (result) => `Revoked identity ${result.revoked}`);
      return undefined;
    },
  });

  parser.addCommand({
    name: "join-token",
    description: "Issue a one-time join token",
    options: [
      { name: "name", type: "string", required: true, description: "Identity name or id" },
      { name: "ttl", type: "number", description: "Lifetime in seconds (1-86400)" },
    ],
    handler: async (options) => {
      const value = requiredText(options, "name");
      const ttl = numberOption(options, "ttl");
      const projectName = context.project();
      const { client } = await context.client();
      const project = await projectId(client, projectName);
      const id = await identityId(client, project, value);
      const token = await client.identities.issueJoinToken({
        id,
        ...(ttl === undefined ? {} : { ttlSeconds: ttl }),
      });
      runtime.stderr("warning: this token is shown once and cannot be retrieved later\n");
      context.render(
        token,
        (result) =>
          `Join token (shown once): ${result.token}\nExpires at ${formatTime(result.expiresAt)}`,
      );
      return undefined;
    },
  });

  return parser;
}

/** The identity group definition. */
export const identityGroup: CommandGroup = {
  name: "identity",
  summary: "Create, list, revoke, and issue join tokens for service identities",
  commands: ["create", "list", "revoke", "join-token"],
  createParser: createIdentityParser,
};
