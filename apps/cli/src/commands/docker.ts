import { lstatSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { composeServiceNameSchema, projectNameSchema } from "@openvault/api-contract";
import { CommandLineParser } from "blendsdk/cmdline";
import { CliError } from "../errors.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext } from "./context.js";
import { writeOutputFile } from "./files.js";
import { flagOption, requiredText, textList, textOption } from "./options.js";

const COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Returns `lstat` or undefined. */
function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      return undefined;
    }
    throw new CliError("file_exists", "The output path could not be inspected");
  }
}

/** Ensures the output directory exists and is safe. */
function ensureOutputDirectory(path: string): void {
  const absolute = resolve(path);
  const stat = lstatIfExists(absolute);
  if (stat === undefined) {
    try {
      mkdirSync(absolute, { recursive: true, mode: 0o755 });
    } catch {
      throw new CliError("usage_error", "The output directory could not be created", {
        exitCode: 2,
      });
    }
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new CliError("file_exists", "The output path must be a real directory");
  }
}

/** Checks one planned target before any API call. */
function preflightTarget(path: string, force: boolean): void {
  const stat = lstatIfExists(path);
  if (stat === undefined) {
    return;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new CliError("file_exists", "The output path must be a regular file");
  }
  if (!force) {
    throw new CliError("file_exists", `The output file already exists: ${basename(path)}`);
  }
}

/**
 * Builds the docker group parser.
 *
 * @param globals - Global options.
 * @param runtime - Process boundary.
 * @returns The configured parser.
 */
export function createDockerParser(globals: GlobalOptions, runtime: CliRuntime): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({
    name: "ov docker",
    version: "1.2.0",
    strict: true,
  });

  parser.addCommand({
    name: "scaffold",
    description: "Add an agent to a Compose service",
    options: [
      { name: "project-name", type: "string", required: true, description: "OpenVault project" },
      { name: "service", type: "string", required: true, description: "Compose service slug" },
      { name: "secret", type: "string", multiple: true, description: "Secret name; repeatable" },
      { name: "compose-project", type: "string", description: "Compose project name" },
      { name: "out", type: "string", description: "Output directory" },
      { name: "force", type: "boolean", description: "Replace existing files" },
    ],
    handler: async (options) => {
      const project = requiredText(options, "project-name");
      if (!projectNameSchema.safeParse(project).success) {
        throw new CliError("usage_error", "Invalid OpenVault project name", { exitCode: 2 });
      }
      const service = requiredText(options, "service");
      if (!composeServiceNameSchema.safeParse(service).success) {
        throw new CliError("usage_error", "Invalid Compose service name", { exitCode: 2 });
      }
      const composeProject = textOption(options, "compose-project") ?? project;
      if (!COMPOSE_PROJECT.test(composeProject)) {
        throw new CliError("usage_error", "Invalid Compose project name", { exitCode: 2 });
      }
      const out = resolve(textOption(options, "out") ?? runtime.cwd);
      ensureOutputDirectory(out);
      const composeName = `openvault.${composeProject}.${service}.compose.yaml`;
      const manifestName = `openvault.${composeProject}.${service}.manifest.yaml`;
      const composePath = resolve(out, composeName);
      const manifestPath = resolve(out, manifestName);
      if (dirname(composePath) !== out || dirname(manifestPath) !== out) {
        throw new CliError("file_exists", "The output path escaped the output directory");
      }
      const force = flagOption(options, "force");
      preflightTarget(composePath, force);
      preflightTarget(manifestPath, force);

      const { client } = await context.client();
      const result = await client.scaffold.createScaffold({
        project,
        service,
        entries: textList(options, "secret"),
      });
      writeOutputFile(composePath, Buffer.from(result.compose, "utf8"), {
        force: true,
        mode: 0o644,
      });
      writeOutputFile(manifestPath, Buffer.from(result.manifest, "utf8"), {
        force: true,
        mode: 0o600,
      });
      runtime.stderr("warning: the join token is shown once; store it outside the Compose file\n");
      context.render(
        {
          project: result.project,
          identity: result.identity,
          assignments: result.assignments,
          joinToken: result.joinToken,
          files: { compose: composePath, manifest: manifestPath },
        },
        (value) =>
          `Scaffolded ${value.identity.name} for ${value.project.name}\n` +
          `compose: ${value.files.compose}\nmanifest: ${value.files.manifest}\n` +
          `join token (shown once): ${value.joinToken.token}`,
      );
      return undefined;
    },
  });

  return parser;
}

/** The docker group definition. */
export const dockerGroup: CommandGroup = {
  name: "docker",
  summary: "Scaffold a Compose service with an OpenVault agent",
  commands: ["scaffold"],
  createParser: createDockerParser,
};
