import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { ApiError } from "blendsdk/api-client";
import { CommandLineParser } from "blendsdk/cmdline";
import { readPassword } from "../credentials/password.js";
import { CliError } from "../errors.js";
import { formatTable, formatTime } from "../output.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext } from "./context.js";
import { writeOutputFile } from "./files.js";
import {
  flagOption,
  numberOption,
  parseTags,
  requiredText,
  textList,
  textOption,
} from "./options.js";

const MAX_VALUE_BYTES = 65_536;

/** Reads all stdin with a bound. */
async function readAll(runtime: CliRuntime, maxBytes: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = (): void => {
      runtime.stdin.removeListener("data", onData);
      runtime.stdin.removeListener("end", onEnd);
      runtime.stdin.removeListener("error", onError);
      runtime.stdin.pause?.();
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      total += bytes.length;
      if (total > maxBytes) {
        cleanup();
        reject(new CliError("validation_error", "The value is too large", { exitCode: 2 }));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new CliError("internal_error", "The value could not be read", { cause: error }));
    };
    runtime.stdin.on("data", onData);
    runtime.stdin.once("end", onEnd);
    runtime.stdin.once("error", onError);
    runtime.stdin.resume?.();
  });
}

/** Reads a value from a file, a file descriptor, or stdin. */
async function readValue(options: Record<string, unknown>, runtime: CliRuntime): Promise<string> {
  const fromFile = textOption(options, "from-file");
  if (flagOption(options, "stdin")) {
    const bytes = await readAll(runtime, MAX_VALUE_BYTES);
    return bytes.toString("utf8");
  }
  if (fromFile !== undefined) {
    const isDescriptor = fromFile.startsWith("/dev/fd/") || fromFile.startsWith("/proc/self/fd/");
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        fromFile,
        constants.O_RDONLY | (isDescriptor ? 0 : constants.O_NOFOLLOW),
      );
      const stat = fstatSync(descriptor);
      if (!isDescriptor && !stat.isFile()) {
        throw new CliError("validation_error", "--from-file must be a regular file", {
          exitCode: 2,
        });
      }
      if (stat.isFile() && stat.size > MAX_VALUE_BYTES) {
        throw new CliError("validation_error", "The value is too large", { exitCode: 2 });
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const buffer = Buffer.alloc(65_536);
      for (;;) {
        const remaining = MAX_VALUE_BYTES + 1 - total;
        if (remaining <= 0) {
          throw new CliError("validation_error", "The value is too large", { exitCode: 2 });
        }
        const bytes = readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
        if (bytes === 0) {
          break;
        }
        chunks.push(Buffer.from(buffer.subarray(0, bytes)));
        total += bytes;
      }
      if (total > MAX_VALUE_BYTES) {
        throw new CliError("validation_error", "The value is too large", { exitCode: 2 });
      }
      return Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }
      throw new CliError("validation_error", "The value file could not be read", {
        exitCode: 2,
        cause: error,
      });
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
    }
  }
  return await readPassword({
    stdin: runtime.stdin,
    isTty: runtime.isTty,
    prompt: "Secret value: ",
    stderr: runtime.stderr,
  });
}

/**
 * Builds the secret group parser.
 *
 * @param globals - Global options.
 * @param runtime - Process boundary.
 * @returns The configured parser.
 */
export function createSecretParser(globals: GlobalOptions, runtime: CliRuntime): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({
    name: "ov secret",
    version: "0.1.0",
    strict: true,
  });

  parser.addCommand({
    name: "set",
    description: "Create a secret or write a new version",
    options: [
      { name: "name", type: "string", required: true, description: "Secret name" },
      { name: "stdin", type: "boolean", description: "Read the value from standard input" },
      { name: "from-file", type: "string", description: "Read the value from a file or fd" },
      {
        name: "encoding",
        type: "string",
        choices: ["utf8", "base64"],
        description: "Value encoding",
      },
      { name: "content-type", type: "string", description: "Content type for a new secret" },
      { name: "expires-at", type: "string", description: "Version expiry (ISO timestamp)" },
      { name: "tag", type: "string", multiple: true, description: "Tag key=value; repeatable" },
      { name: "idempotency-key", type: "string", description: "Idempotency key" },
    ],
    handler: async (options) => {
      const name = requiredText(options, "name");
      const project = context.project();
      const value = await readValue(options, runtime);
      if (value.length === 0) {
        throw new CliError("validation_error", "The value is empty", { exitCode: 2 });
      }
      if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
        throw new CliError("validation_error", "The value is too large", { exitCode: 2 });
      }
      const rawEncoding = textOption(options, "encoding") ?? "utf8";
      if (rawEncoding !== "utf8" && rawEncoding !== "base64") {
        throw new CliError("usage_error", "Unknown secret encoding", { exitCode: 2 });
      }
      const encoding: "utf8" | "base64" = rawEncoding;
      if (encoding === "base64") {
        const decoded = Buffer.from(value, "base64");
        if (decoded.length === 0 || decoded.toString("base64") !== value.replace(/\s+/g, "")) {
          throw new CliError("validation_error", "The base64 value is invalid", { exitCode: 2 });
        }
      }
      const tags = parseTags(textList(options, "tag"));
      const contentType = textOption(options, "content-type");
      const expiresAt = textOption(options, "expires-at");
      const idempotencyKey = textOption(options, "idempotency-key") ?? randomUUID();
      const { client } = await context.client();
      let updated = false;
      let result: { readonly name: string; readonly version: { readonly id: string } };
      try {
        result = await client.secrets.writeSecretValue(
          {
            project,
            name,
            value,
            encoding,
            ...(expiresAt === undefined ? {} : { expiresAt }),
          },
          { headers: { "Idempotency-Key": idempotencyKey } },
        );
        updated = true;
      } catch (error) {
        if (!(error instanceof ApiError) || error.statusCode !== 404) {
          throw error;
        }
        try {
          result = await client.secrets.createSecret(
            {
              project,
              name,
              value,
              encoding,
              ...(contentType === undefined ? {} : { contentType }),
              ...(Object.keys(tags).length === 0 ? {} : { tags }),
              ...(expiresAt === undefined ? {} : { expiresAt }),
            },
            { headers: { "Idempotency-Key": randomUUID() } },
          );
        } catch (createError) {
          if (createError instanceof ApiError && createError.statusCode === 409) {
            result = await client.secrets.writeSecretValue(
              {
                project,
                name,
                value,
                encoding,
                ...(expiresAt === undefined ? {} : { expiresAt }),
              },
              { headers: { "Idempotency-Key": randomUUID() } },
            );
            updated = true;
          } else {
            throw createError;
          }
        }
      }
      if (updated && (Object.keys(tags).length > 0 || contentType !== undefined)) {
        await client.secrets.updateSecretMetadata({
          project,
          name,
          ...(Object.keys(tags).length === 0 ? {} : { tags }),
          ...(contentType === undefined ? {} : { contentType }),
        });
      }
      context.render(result, (metadata) => `Set ${metadata.name} version ${metadata.version.id}`);
      return undefined;
    },
  });

  parser.addCommand({
    name: "get",
    description: "Read one secret value",
    options: [
      { name: "name", type: "string", required: true, description: "Secret name" },
      { name: "version-id", type: "string", description: "Version id" },
      { name: "out", type: "string", description: "Write the value to a file" },
      { name: "force", type: "boolean", description: "Replace an existing output file" },
    ],
    handler: async (options) => {
      const name = requiredText(options, "name");
      const version = textOption(options, "version-id");
      const out = textOption(options, "out");
      const project = context.project();
      const { client } = await context.client();
      const response = await client.secrets.getSecret({
        project,
        name,
        ...(version === undefined ? {} : { version }),
      });
      if (out !== undefined) {
        const bytes =
          response.encoding === "base64"
            ? Buffer.from(response.value, "base64")
            : Buffer.from(response.value, "utf8");
        writeOutputFile(out, bytes, { force: flagOption(options, "force") });
        context.render({ name, out }, (value) => `Wrote ${value.name} to ${value.out}`);
        return undefined;
      }
      if (globals.json) {
        context.render(response, () => "");
        return undefined;
      }
      runtime.stdout(response.value);
      return undefined;
    },
  });

  parser.addCommand({
    name: "list",
    description: "List secrets in a project",
    options: [
      { name: "q", type: "string", description: "Name substring" },
      { name: "tag-key", type: "string", description: "Tag key" },
      { name: "tag-value", type: "string", description: "Tag value" },
      { name: "limit", type: "number", description: "Page size (1-100)" },
      { name: "cursor", type: "string", description: "Pagination cursor" },
    ],
    handler: async (options) => {
      const project = context.project();
      const { client } = await context.client();
      const q = textOption(options, "q");
      const tagKey = textOption(options, "tag-key");
      const tagValue = textOption(options, "tag-value");
      const cursor = textOption(options, "cursor");
      const limit = numberOption(options, "limit");
      const result = await client.secrets.listSecrets({
        project,
        ...(q === undefined ? {} : { q }),
        ...(tagKey === undefined ? {} : { tagKey }),
        ...(tagValue === undefined ? {} : { tagValue }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      });
      context.render(result, (value) =>
        formatTable(
          ["NAME", "STATUS", "VERSION", "EXPIRES", "TAGS"],
          value.secrets.map((secret) => [
            secret.name,
            secret.status,
            secret.currentVersion?.id ?? "-",
            secret.currentVersion?.expiresAt === null || secret.currentVersion === null
              ? "-"
              : formatTime(secret.currentVersion.expiresAt),
            Object.entries(secret.tags)
              .map(([key, entry]) => `${key}=${entry}`)
              .join(","),
          ]),
        ),
      );
      return undefined;
    },
  });

  parser.addCommand({
    name: "versions",
    description: "List secret versions",
    options: [{ name: "name", type: "string", required: true, description: "Secret name" }],
    handler: async (options) => {
      const project = context.project();
      const { client } = await context.client();
      const result = await client.secrets.listSecretVersions({
        project,
        name: requiredText(options, "name"),
      });
      context.render(result, (value) =>
        formatTable(
          ["VERSION", "CREATED", "STATUS", "CURRENT"],
          value.versions.map((version) => [
            version.id,
            formatTime(version.createdAt),
            version.status,
            version.isCurrent ? "yes" : "no",
          ]),
        ),
      );
      return undefined;
    },
  });

  parser.addCommand({
    name: "delete",
    description: "Soft-delete a secret",
    options: [{ name: "name", type: "string", required: true, description: "Secret name" }],
    handler: async (options) => {
      const name = requiredText(options, "name");
      const project = context.project();
      await context.confirm(`Delete secret ${name}?`);
      const { client } = await context.client();
      await client.secrets.deleteSecret({ project, name });
      context.render({ deleted: name }, (value) => `Deleted ${value.deleted}`);
      return undefined;
    },
  });

  parser.addCommand({
    name: "recover",
    description: "Recover a soft-deleted secret",
    options: [{ name: "name", type: "string", required: true, description: "Secret name" }],
    handler: async (options) => {
      const project = context.project();
      const { client } = await context.client();
      const result = await client.secrets.recoverSecret({
        project,
        name: requiredText(options, "name"),
      });
      context.render(result, (metadata) => `Recovered ${metadata.name}`);
      return undefined;
    },
  });

  parser.addCommand({
    name: "purge",
    description: "Purge a deleted secret",
    options: [{ name: "name", type: "string", required: true, description: "Secret name" }],
    handler: async (options) => {
      const name = requiredText(options, "name");
      const project = context.project();
      await context.confirm(`Purge secret ${name} permanently?`);
      const { client } = await context.client();
      await client.secrets.purgeSecret({ project, name });
      context.render({ purged: name }, (value) => `Purged ${value.purged}`);
      return undefined;
    },
  });

  return parser;
}

/** The secret group definition. */
export const secretGroup: CommandGroup = {
  name: "secret",
  summary: "Create, read, version, delete, recover, and purge secrets",
  commands: ["set", "get", "list", "versions", "delete", "recover", "purge"],
  createParser: createSecretParser,
};
