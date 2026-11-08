import { CommandLineParser } from "blendsdk/cmdline";
import { CliError } from "../errors.js";
import { formatTable, formatTime } from "../output.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext } from "./context.js";

/** Returns one required string option. */
function requiredText(options: Record<string, unknown>, name: string): string {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError("usage_error", `--${name} is required`, { exitCode: 2 });
  }
  return value;
}

/**
 * Builds the project group parser.
 *
 * @param globals - Global options.
 * @param runtime - Process boundary.
 * @returns The configured parser.
 */
export function createProjectParser(
  globals: GlobalOptions,
  runtime: CliRuntime,
): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({
    name: "ov project",
    version: "1.0.0",
    strict: true,
  });

  parser.addCommand({
    name: "list",
    description: "List visible projects",
    handler: async () => {
      const { client } = await context.client();
      const result = await client.projects.listProjects();
      context.render(result, (value) =>
        formatTable(
          ["NAME", "ID", "CERTIFICATES", "DELETED"],
          value.projects.map((project) => [
            project.name,
            project.id,
            String(project.certificateCount),
            project.deletedAt === null ? "no" : formatTime(project.deletedAt),
          ]),
        ),
      );
      return undefined;
    },
  });

  parser.addCommand({
    name: "create",
    description: "Create a project",
    options: [{ name: "name", type: "string", required: true, description: "Project name" }],
    handler: async (options) => {
      const { client } = await context.client();
      const project = await client.projects.createProject({
        name: requiredText(options, "name"),
      });
      context.render(project, (value) => `Created project ${value.name} (${value.id})`);
      return undefined;
    },
  });

  parser.addCommand({
    name: "delete",
    description: "Soft-delete a project by name",
    options: [{ name: "name", type: "string", required: true, description: "Project name" }],
    handler: async (options) => {
      const name = requiredText(options, "name");
      const { client } = await context.client();
      const list = await client.projects.listProjects();
      const project = list.projects.find((entry) => entry.name === name);
      if (project === undefined) {
        throw new CliError("project_not_found", "Project not found", { exitCode: 5 });
      }
      await context.confirm(`Delete project ${name}?`);
      await client.projects.deleteProject({ project: project.id });
      context.render({ deleted: name }, (value) => `Deleted project ${value.deleted}`);
      return undefined;
    },
  });

  return parser;
}

/** The project group definition. */
export const projectGroup: CommandGroup = {
  name: "project",
  summary: "List, create, and delete projects",
  commands: ["list", "create", "delete"],
  createParser: createProjectParser,
};
