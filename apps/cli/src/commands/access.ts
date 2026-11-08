import { RBAC_ACTIONS, type RbacAction } from "@openvault/api-contract";
import { CommandLineParser } from "blendsdk/cmdline";
import { CliError } from "../errors.js";
import { formatTable } from "../output.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext } from "./context.js";
import { requiredText, textOption } from "./options.js";
import { certificateId, projectId, secretId } from "./resolve.js";

/** Returns true for one fixed action. */
function isAction(value: string): value is RbacAction {
  return RBAC_ACTIONS.some((action) => action === value);
}

/**
 * Builds the access group parser.
 *
 * @param globals - Global options.
 * @param runtime - Process boundary.
 * @returns The configured parser.
 */
export function createAccessParser(globals: GlobalOptions, runtime: CliRuntime): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({
    name: "ov access",
    version: "1.0.0",
    strict: true,
  });

  parser.addCommand({
    name: "explain",
    description: "Explain effective access to a secret, certificate, or project",
    options: [
      { name: "target", type: "string", required: true, description: "Object or project name" },
      {
        name: "target-type",
        type: "string",
        choices: ["secret", "certificate", "project"],
        description: "Target type",
      },
      { name: "action", type: "string", description: "Action to explain" },
    ],
    handler: async (options) => {
      const target = requiredText(options, "target");
      const targetType = textOption(options, "target-type") ?? "secret";
      const project = targetType === "project" ? undefined : context.project();
      const { client } = await context.client();
      let scopeType: "project" | "object";
      let scopeId: string;
      let objectType: "secret" | "certificate" | undefined;
      let defaultAction: string;
      if (targetType === "project") {
        scopeType = "project";
        scopeId = await projectId(client, target);
        defaultAction = "project.read";
      } else if (targetType === "certificate") {
        if (project === undefined) {
          throw new CliError("usage_error", "--project is required", { exitCode: 2 });
        }
        scopeType = "object";
        scopeId = await certificateId(client, project, target);
        objectType = "certificate";
        defaultAction = "certificate.read";
      } else {
        if (project === undefined) {
          throw new CliError("usage_error", "--project is required", { exitCode: 2 });
        }
        scopeType = "object";
        scopeId = await secretId(client, project, target);
        objectType = "secret";
        defaultAction = "secret.read";
      }
      const action = textOption(options, "action") ?? defaultAction;
      if (!isAction(action)) {
        throw new CliError("usage_error", `Unknown action: ${action}`, { exitCode: 2 });
      }
      const explanation = await client.access.explainAccess({
        action,
        scopeType,
        scopeId,
        ...(objectType === undefined ? {} : { objectType }),
      });
      context.render(explanation, (value) =>
        formatTable(
          ["PRINCIPAL", "KIND", "ROLE", "SCOPE", "ASSIGNMENT", "CONSUMER"],
          value.principals.map((entry) => [
            entry.name,
            entry.kind,
            entry.role,
            `${entry.scopeType}:${entry.scopeId}`,
            entry.assignmentId,
            entry.consumer === null
              ? "-"
              : `${entry.consumer.composeProject}/${entry.consumer.composeService} ${entry.consumer.state}`,
          ]),
        ),
      );
      return undefined;
    },
  });

  return parser;
}

/** The access group definition. */
export const accessGroup: CommandGroup = {
  name: "access",
  summary: "Explain effective access and consumers",
  commands: ["explain"],
  createParser: createAccessParser,
};
