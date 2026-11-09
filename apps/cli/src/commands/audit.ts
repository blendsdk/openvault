import { resolve } from "node:path";
import { AUDIT_ACTIONS, type AuditAction } from "@openvault/api-contract";
import { CommandLineParser } from "blendsdk/cmdline";
import { CliError } from "../errors.js";
import { formatTable, formatTime } from "../output.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext } from "./context.js";
import { databaseUrlFromEnv } from "./database-url.js";
import { numberOption, requiredText, textOption } from "./options.js";
import { projectId } from "./resolve.js";

/** Returns true for one audit action. */
function isAuditAction(value: string): value is AuditAction {
  return AUDIT_ACTIONS.some((action) => action === value);
}

/** Returns one result filter. */
function auditResult(value: string | undefined): "allow" | "deny" | "error" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "allow" || value === "deny" || value === "error") {
    return value;
  }
  throw new CliError("usage_error", "Unknown result filter", { exitCode: 2 });
}

/** Builds the shared audit filter object. */
async function filters(
  options: Record<string, unknown>,
  context: ReturnType<typeof createCommandContext>,
): Promise<Record<string, string | number>> {
  const { client } = await context.client();
  const projectName = textOption(options, "project") ?? context.globals.project;
  const explicitProject = textOption(options, "project-id");
  let project: string | undefined;
  if (explicitProject !== undefined) {
    project = explicitProject;
  } else if (projectName !== undefined) {
    project = await projectId(client, projectName);
  }
  const action = textOption(options, "action");
  if (action !== undefined && !isAuditAction(action)) {
    throw new CliError("usage_error", `Unknown audit action: ${action}`, { exitCode: 2 });
  }
  const result = auditResult(textOption(options, "result"));
  const limit = numberOption(options, "limit");
  const cursor = textOption(options, "cursor");
  const from = textOption(options, "from");
  const to = textOption(options, "to");
  const actorId = textOption(options, "actor-id");
  const objectType = textOption(options, "object-type");
  const objectId = textOption(options, "object-id");
  const requestId = textOption(options, "request-id");
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(action === undefined ? {} : { action }),
    ...(objectType === undefined ? {} : { objectType }),
    ...(objectId === undefined ? {} : { objectId }),
    ...(result === undefined ? {} : { result }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(project === undefined ? {} : { projectId: project }),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** The shared filter options. */
const FILTER_OPTIONS = [
  { name: "from", type: "string" as const, description: "ISO lower bound" },
  { name: "to", type: "string" as const, description: "ISO upper bound" },
  { name: "actor-id", type: "string" as const, description: "Actor ULID" },
  { name: "action", type: "string" as const, description: "Audit action" },
  { name: "object-type", type: "string" as const, description: "Object type" },
  { name: "object-id", type: "string" as const, description: "Object id" },
  {
    name: "result",
    type: "string" as const,
    choices: ["allow", "deny", "error"],
    description: "Result filter",
  },
  { name: "request-id", type: "string" as const, description: "Request id" },
  { name: "project-id", type: "string" as const, description: "Project ULID" },
  { name: "limit", type: "number" as const, description: "Page size (1-500)" },
  { name: "cursor", type: "string" as const, description: "Pagination cursor" },
];

/**
 * Builds the audit group parser.
 *
 * @param globals - Global options.
 * @param runtime - Process boundary.
 * @returns The configured parser.
 */
export function createAuditParser(globals: GlobalOptions, runtime: CliRuntime): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({
    name: "ov audit",
    version: "1.2.0",
    strict: true,
  });

  parser.addCommand({
    name: "list",
    description: "Query audit events",
    options: FILTER_OPTIONS,
    handler: async (options) => {
      const { client } = await context.client();
      const query = await filters(options, context);
      const result = await client.audit.listAuditEvents(query);
      context.render(result, (value) =>
        formatTable(
          ["TIME", "ACTION", "ACTOR", "RESULT", "OBJECT", "REQUEST"],
          value.events.map((event) => [
            formatTime(event.ts),
            event.action,
            String(event.actorId ?? "-"),
            event.result,
            event.objectType === null ? "-" : `${event.objectType}:${event.objectId ?? "-"}`,
            event.requestId,
          ]),
        ),
      );
      return undefined;
    },
  });

  parser.addCommand({
    name: "verify",
    description: "Verify the audit chain",
    handler: async () => {
      const { client } = await context.client();
      const result = await client.audit.verifyAudit();
      if (!result.ok) {
        const first = result.firstBrokenEventId ?? "none";
        throw new CliError(
          "audit_chain_broken",
          `Audit chain is broken (${result.reason}); first bad event ${first}`,
          { exitCode: 1, details: result },
        );
      }
      context.render(
        result,
        (value) =>
          `Audit chain ok (${value.checkedRange?.fromEventId ?? "-"}..${value.checkedRange?.toEventId ?? "-"})`,
      );
      return undefined;
    },
  });

  parser.addCommand({
    name: "export",
    description: "Export matching audit events as NDJSON",
    options: [
      ...FILTER_OPTIONS.filter((option) => option.name !== "limit" && option.name !== "cursor"),
      { name: "out", type: "string" as const, required: true, description: "Output file" },
      { name: "force", type: "boolean" as const, description: "Replace an existing output file" },
    ],
    handler: async (options) => {
      const out = requiredText(options, "out");
      const { transport, authHeaders, refreshAccessToken } = await context.client();
      const query = await filters(options, context);
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        search.set(key, String(value));
      }
      const result = await transport.download(
        `/v1/audit/export${search.size === 0 ? "" : `?${search.toString()}`}`,
        out,
        {
          headers: await authHeaders(),
          force: options.force === true,
          onUnauthorized: async () => ({
            Authorization: `Bearer ${await refreshAccessToken()}`,
          }),
        },
      );
      context.render(
        { out, bytes: result.bytes },
        (value) => `Exported ${value.bytes} bytes to ${value.out}`,
      );
      return undefined;
    },
  });

  parser.addCommand({
    name: "checkpoint",
    description: "Export the newest audit checkpoint for off-box retention",
    options: [
      { name: "out", type: "string", required: true, description: "Output file; must not exist" },
    ],
    handler: async (options) => {
      const databaseUrl = databaseUrlFromEnv(runtime);
      const outPath = resolve(runtime.cwd, requiredText(options, "out"));
      const runner =
        runtime.runCheckpointExport ?? (await import("@openvault/server/ops")).runCheckpointExport;
      const result = await runner({ databaseUrl, outPath });
      context.render(
        result,
        (value) =>
          `Exported checkpoint ${value.id} (last event ${value.lastEventId}) to ${value.outPath}`,
      );
      return undefined;
    },
  });

  return parser;
}

/** The audit group definition. */
export const auditGroup: CommandGroup = {
  name: "audit",
  summary: "Query, verify, export, and checkpoint the audit chain",
  commands: ["list", "verify", "export", "checkpoint"],
  createParser: createAuditParser,
};
