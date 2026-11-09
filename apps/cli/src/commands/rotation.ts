import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { CommandLineParser } from "blendsdk/cmdline";
import { CliError } from "../errors.js";
import { formatTable, formatTime } from "../output.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext } from "./context.js";
import { writeOutputFile } from "./files.js";
import { flagOption, numberOption, requiredText, textOption } from "./options.js";
import { readValue } from "./secret.js";

const MIN_INTERVAL_DAYS = 1;
const MAX_INTERVAL_DAYS = 3_650;

/** Returns a string for a generated-client value that may be typed as unknown. */
function publicText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Formats one rotation due date and status for human output. */
function dueLabel(dueAt: unknown, status: unknown): string {
  const date = publicText(dueAt);
  if (date === null) {
    return "no due date";
  }
  return `${formatTime(date)} (${publicText(status) ?? "unknown"})`;
}

/**
 * Builds the rotation command group.
 *
 * @param globals - Global options.
 * @param runtime - Process boundary.
 * @returns The configured parser.
 */
export function createRotationParser(
  globals: GlobalOptions,
  runtime: CliRuntime,
): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({
    name: "ov rotation",
    version: "1.2.0",
    strict: true,
  });

  parser.addCommand({
    name: "set",
    description: "Set a rotation policy for a secret",
    options: [
      { name: "name", type: "string", required: true, description: "Secret name" },
      {
        name: "every-days",
        type: "number",
        required: true,
        description: "Rotation interval in days (1-3650)",
      },
    ],
    handler: async (options) => {
      const name = requiredText(options, "name");
      const days = numberOption(options, "every-days");
      if (days === undefined || days < MIN_INTERVAL_DAYS || days > MAX_INTERVAL_DAYS) {
        throw new CliError("usage_error", "--every-days must be between 1 and 3650", {
          exitCode: 2,
        });
      }
      const project = context.project();
      const { client } = await context.client();
      const result = await client.secrets.updateSecretMetadata({
        project,
        name,
        rotationIntervalDays: days,
      });
      context.render(
        result,
        (metadata) =>
          `Set ${metadata.name} to rotate every ${metadata.rotationIntervalDays} days; due ${dueLabel(
            metadata.rotationDueAt,
            metadata.rotationStatus,
          )}`,
      );
      return undefined;
    },
  });

  parser.addCommand({
    name: "clear",
    description: "Remove a rotation policy from a secret",
    options: [{ name: "name", type: "string", required: true, description: "Secret name" }],
    handler: async (options) => {
      const name = requiredText(options, "name");
      const project = context.project();
      const { client } = await context.client();
      const result = await client.secrets.updateSecretMetadata({
        project,
        name,
        rotationIntervalDays: null,
      });
      context.render(result, (metadata) => `Cleared the rotation policy for ${metadata.name}`);
      return undefined;
    },
  });

  parser.addCommand({
    name: "list",
    description: "List secrets with a rotation policy",
    options: [
      { name: "due", type: "boolean", description: "Due-soon or overdue only" },
      { name: "overdue", type: "boolean", description: "Overdue only" },
      { name: "limit", type: "number", description: "Page size (1-100)" },
      { name: "cursor", type: "string", description: "Pagination cursor" },
    ],
    handler: async (options) => {
      const due = flagOption(options, "due");
      const overdue = flagOption(options, "overdue");
      if (due && overdue) {
        throw new CliError("usage_error", "--due cannot be combined with --overdue", {
          exitCode: 2,
        });
      }
      const project = context.project();
      const { client } = await context.client();
      const limit = numberOption(options, "limit");
      const cursor = textOption(options, "cursor");
      const result = await client.secrets.listSecrets({
        project,
        rotation: overdue ? "overdue" : due ? "due" : "policy",
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      context.render(result, (value) =>
        formatTable(
          ["NAME", "STATUS", "DUE", "INTERVAL", "LAST ROTATED"],
          value.secrets.map((secret) => [
            secret.name,
            publicText(secret.rotationStatus) ?? "-",
            formatTime(publicText(secret.rotationDueAt) ?? "-"),
            secret.rotationIntervalDays === null
              ? "-"
              : `every ${secret.rotationIntervalDays} days`,
            formatTime(publicText(secret.currentVersion?.createdAt) ?? "-"),
          ]),
        ),
      );
      return undefined;
    },
  });

  parser.addCommand({
    name: "status",
    description: "Show one secret's rotation policy and consumers",
    options: [{ name: "name", type: "string", required: true, description: "Secret name" }],
    handler: async (options) => {
      const name = requiredText(options, "name");
      const project = context.project();
      const { client } = await context.client();
      const page = await client.secrets.listSecrets({ project, q: name, limit: 100 });
      const secret = page.secrets.find((entry) => entry.name === name);
      if (secret === undefined) {
        throw new CliError("secret_not_found", "Secret not found", { exitCode: 1 });
      }
      context.render(secret, (value) =>
        [
          `Name: ${value.name}`,
          `Policy: ${value.rotationIntervalDays === null ? "No policy" : `every ${value.rotationIntervalDays} days`}`,
          `Due: ${dueLabel(value.rotationDueAt, value.rotationStatus)}`,
          `Current version: ${value.currentVersion?.id ?? "-"}`,
          "Consumers:",
          ...(value.consumers.length === 0
            ? ["  none"]
            : value.consumers.map(
                (consumer) =>
                  `  ${consumer.composeProject}/${consumer.composeService} ${consumer.state} ${formatTime(consumer.lastSeen)}`,
              )),
        ].join("\n"),
      );
      return undefined;
    },
  });

  parser.addCommand({
    name: "rotate",
    description: "Rotate a secret with a supplied or generated value",
    options: [
      { name: "name", type: "string", required: true, description: "Secret name" },
      { name: "generate", type: "boolean", description: "Generate a 32-byte base64url value" },
      { name: "out", type: "string", description: "Write the generated value to a file" },
      { name: "force", type: "boolean", description: "Replace an existing output file" },
      { name: "expires-at", type: "string", description: "Optional version expiry" },
      {
        name: "encoding",
        type: "string",
        choices: ["utf8", "base64"],
        description: "Value encoding",
      },
      { name: "stdin", type: "boolean", description: "Read the value from standard input" },
      { name: "from-file", type: "string", description: "Read the value from a file or fd" },
      { name: "idempotency-key", type: "string", description: "Idempotency key" },
    ],
    handler: async (options) => {
      const name = requiredText(options, "name");
      const generate = flagOption(options, "generate");
      const out = textOption(options, "out");
      const force = flagOption(options, "force");
      const stdin = flagOption(options, "stdin");
      const fromFile = textOption(options, "from-file");
      if (out !== undefined && !generate) {
        throw new CliError("usage_error", "--out requires --generate", { exitCode: 2 });
      }
      if (generate && (stdin || fromFile !== undefined)) {
        throw new CliError(
          "usage_error",
          "--generate cannot be combined with --stdin/--from-file",
          { exitCode: 2 },
        );
      }
      if (!generate && !stdin && fromFile === undefined) {
        throw new CliError("usage_error", "Provide --generate, --stdin, or --from-file", {
          exitCode: 2,
        });
      }
      const project = context.project();
      const { client } = await context.client();
      const expiresAt = textOption(options, "expires-at");
      const rawEncoding = textOption(options, "encoding") ?? "utf8";
      if (rawEncoding !== "utf8" && rawEncoding !== "base64") {
        throw new CliError("usage_error", "Unknown secret encoding", { exitCode: 2 });
      }
      const encoding: "utf8" | "base64" = rawEncoding;
      const idempotencyKey = textOption(options, "idempotency-key");
      const value = generate
        ? randomBytes(32).toString("base64url")
        : await readValue(options, runtime);
      if (value.length === 0) {
        throw new CliError("validation_error", "The value is empty", { exitCode: 2 });
      }
      let wroteFile = false;
      if (out !== undefined) {
        try {
          writeOutputFile(out, Buffer.from(value, "utf8"), { force });
        } catch (error) {
          if (error instanceof CliError && error.code === "file_exists") {
            throw new CliError("file_exists", error.message, { exitCode: 2 });
          }
          throw error;
        }
        wroteFile = true;
      }
      let result: Awaited<ReturnType<typeof client.secrets.writeSecretValue>>;
      try {
        result = await client.secrets.writeSecretValue(
          {
            project,
            name,
            value,
            encoding,
            ...(expiresAt === undefined ? {} : { expiresAt }),
          },
          ...(idempotencyKey === undefined
            ? []
            : [{ headers: { "Idempotency-Key": idempotencyKey } }]),
        );
      } catch (error) {
        if (wroteFile) {
          rmSync(out as string, { force: true });
        }
        throw error;
      }
      if (generate && out === undefined) {
        if (globals.json) {
          runtime.stderr(`Generated value: ${value}\n`);
        } else {
          runtime.stdout(`Generated value: ${value}\n`);
        }
        runtime.stderr("Copy this value now. It will not be shown again.\n");
      }
      context.render(result, (metadata) => {
        const due = dueLabel(metadata.rotationDueAt, metadata.rotationStatus);
        if (out !== undefined) {
          return `Rotated ${metadata.name} to version ${metadata.version.id}; wrote the generated value to ${out}; next due ${due}`;
        }
        return `Rotated ${metadata.name} to version ${metadata.version.id}; next due ${due}`;
      });
      return undefined;
    },
  });

  return parser;
}

/** The rotation group definition. */
export const rotationGroup: CommandGroup = {
  name: "rotation",
  summary: "Set, inspect, list, and rotate secret rotation policies",
  commands: ["set", "clear", "list", "status", "rotate"],
  createParser: createRotationParser,
};
