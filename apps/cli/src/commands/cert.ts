import { readFileSync, statSync } from "node:fs";
import type { CertificateKeyType } from "@openvault/api-contract";
import { CommandLineParser } from "blendsdk/cmdline";
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

function isKeyType(value: string): value is CertificateKeyType {
  return value === "ec-p256" || value === "rsa-2048" || value === "rsa-3072";
}

const MAX_CERT_BYTES = 262_144;
const MAX_KEY_BYTES = 65_536;

/** Reads one PEM file with a bound. */
function readPem(path: string, maxBytes: number, label: string): string {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) {
      throw new Error("invalid file");
    }
    const pem = readFileSync(path, "utf8");
    if (!pem.includes("-----BEGIN ")) {
      throw new Error("not a PEM file");
    }
    return pem;
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("validation_error", `${label} could not be read`, {
      exitCode: 2,
      cause: error,
    });
  }
}

/**
 * Builds the certificate group parser.
 *
 * @param globals - Global options.
 * @param runtime - Process boundary.
 * @returns The configured parser.
 */
export function createCertParser(globals: GlobalOptions, runtime: CliRuntime): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({
    name: "ov cert",
    version: "1.1.0",
    strict: true,
  });

  parser.addCommand({
    name: "import",
    description: "Import a certificate and private key",
    options: [
      { name: "name", type: "string", required: true, description: "Certificate name" },
      { name: "cert", type: "string", required: true, description: "Leaf certificate PEM path" },
      { name: "chain", type: "string", description: "Intermediate chain PEM path" },
      { name: "key", type: "string", required: true, description: "Private key PEM path" },
      { name: "tag", type: "string", multiple: true, description: "Tag key=value; repeatable" },
      {
        name: "allow-not-yet-valid",
        type: "boolean",
        description: "Accept a certificate that is not yet valid",
      },
      { name: "version-id", type: "string", description: "Expected current version id" },
    ],
    handler: async (options) => {
      const certPath = requiredText(options, "cert");
      const keyPath = requiredText(options, "key");
      const chainPath = textOption(options, "chain");
      const version = textOption(options, "version-id");
      const tags = parseTags(textList(options, "tag"));
      const project = context.project();
      const { client } = await context.client();
      const result = await client.certificates.importCertificate({
        project,
        name: requiredText(options, "name"),
        certificatePem: readPem(certPath, MAX_CERT_BYTES, "The certificate"),
        privateKeyPem: readPem(keyPath, MAX_KEY_BYTES, "The private key"),
        ...(chainPath === undefined
          ? {}
          : { chainPem: readPem(chainPath, MAX_CERT_BYTES, "The chain") }),
        ...(version === undefined ? {} : { expectedVersionId: version }),
        ...(Object.keys(tags).length === 0 ? {} : { tags }),
        ...(flagOption(options, "allow-not-yet-valid") ? { allowNotYetValid: true } : {}),
      });
      context.render(result, (value) => {
        const warnings =
          value.warnings.length === 0
            ? ""
            : `\nwarnings: ${value.warnings.map((warning) => warning.code).join(", ")}`;
        return `Imported ${value.name} (${value.fingerprint})${warnings}`;
      });
      return undefined;
    },
  });

  parser.addCommand({
    name: "generate",
    description: "Generate a self-signed certificate",
    options: [
      { name: "name", type: "string", required: true, description: "Certificate name" },
      { name: "subject", type: "string", required: true, description: "RFC 4514 subject" },
      {
        name: "san",
        type: "string",
        multiple: true,
        required: true,
        description: "Typed SAN, for example DNS:api",
      },
      {
        name: "key-type",
        type: "string",
        choices: ["rsa-2048", "rsa-3072", "ec-p256"],
        description: "Key profile",
      },
      { name: "validity-days", type: "number", description: "Validity in days (1-825)" },
      { name: "tag", type: "string", multiple: true, description: "Tag key=value; repeatable" },
      { name: "version-id", type: "string", description: "Expected current version id" },
    ],
    handler: async (options) => {
      const sans = textList(options, "san");
      if (sans.length === 0) {
        throw new CliError("usage_error", "--san is required", { exitCode: 2 });
      }
      const rawKeyType = textOption(options, "key-type");
      if (rawKeyType !== undefined && !isKeyType(rawKeyType)) {
        throw new CliError("usage_error", "Unknown key type", { exitCode: 2 });
      }
      const keyType = rawKeyType;
      const validityDays = numberOption(options, "validity-days");
      const version = textOption(options, "version-id");
      const tags = parseTags(textList(options, "tag"));
      const project = context.project();
      const { client } = await context.client();
      const result = await client.certificates.generateCertificate({
        project,
        name: requiredText(options, "name"),
        subject: requiredText(options, "subject"),
        sans,
        ...(keyType === undefined ? {} : { keyType }),
        ...(validityDays === undefined ? {} : { validityDays }),
        ...(version === undefined ? {} : { expectedVersionId: version }),
        ...(Object.keys(tags).length === 0 ? {} : { tags }),
      });
      context.render(
        result,
        (value) =>
          `Generated ${value.name} (${value.fingerprint}) until ${formatTime(value.notAfter)}`,
      );
      return undefined;
    },
  });

  parser.addCommand({
    name: "get",
    description: "Read a certificate chain or private key",
    options: [
      { name: "name", type: "string", required: true, description: "Certificate name" },
      { name: "version-id", type: "string", description: "Version id" },
      { name: "private-key", type: "boolean", description: "Read the private key" },
      { name: "out", type: "string", description: "Write the private key to a file" },
      { name: "force", type: "boolean", description: "Replace an existing output file" },
    ],
    handler: async (options) => {
      const name = requiredText(options, "name");
      const version = textOption(options, "version-id");
      const privateKey = flagOption(options, "private-key");
      const out = textOption(options, "out");
      if (privateKey && out === undefined) {
        throw new CliError(
          "usage_error",
          "--private-key requires --out; private keys are never printed to stdout",
          { exitCode: 2 },
        );
      }
      const project = context.project();
      const { client } = await context.client();
      if (privateKey) {
        if (out === undefined) {
          throw new CliError("usage_error", "--private-key requires --out", { exitCode: 2 });
        }
        const response = await client.certificates.getCertificatePrivateKey({
          project,
          name,
          ...(version === undefined ? {} : { version }),
        });
        writeOutputFile(out, Buffer.from(response.privateKeyPem, "utf8"), {
          force: flagOption(options, "force"),
        });
        context.render(
          { name: response.name, out, fingerprint: response.fingerprint },
          (value) => `Wrote private key for ${value.name} to ${value.out}`,
        );
        return undefined;
      }
      const response = await client.certificates.getCertificate({
        project,
        name,
        ...(version === undefined ? {} : { version }),
      });
      if (globals.json) {
        context.render(response, () => "");
        return undefined;
      }
      runtime.stdout(response.certificatePem);
      if (response.chainPem.length > 0 && response.chainPem !== response.certificatePem) {
        runtime.stdout(response.chainPem);
      }
      return undefined;
    },
  });

  parser.addCommand({
    name: "list",
    description: "List certificates in a project",
    options: [
      { name: "q", type: "string", description: "Subject or SAN substring" },
      { name: "san", type: "string", description: "Typed SAN filter" },
      { name: "expires-before", type: "string", description: "ISO expiry upper bound" },
      { name: "expires-after", type: "string", description: "ISO expiry lower bound" },
      { name: "limit", type: "number", description: "Page size (1-100)" },
      { name: "cursor", type: "string", description: "Pagination cursor" },
    ],
    handler: async (options) => {
      const q = textOption(options, "q");
      const san = textOption(options, "san");
      const expiresBefore = textOption(options, "expires-before");
      const expiresAfter = textOption(options, "expires-after");
      const cursor = textOption(options, "cursor");
      const limit = numberOption(options, "limit");
      const project = context.project();
      const { client } = await context.client();
      const result = await client.certificates.listCertificates({
        project,
        ...(q === undefined ? {} : { q }),
        ...(san === undefined ? {} : { san }),
        ...(expiresBefore === undefined ? {} : { expiresBefore }),
        ...(expiresAfter === undefined ? {} : { expiresAfter }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      });
      context.render(result, (value) =>
        formatTable(
          ["NAME", "SUBJECT", "EXPIRES", "DAYS", "STATUS"],
          value.certificates.map((certificate) => [
            certificate.name,
            certificate.subject,
            formatTime(certificate.notAfter),
            String(certificate.daysToExpiry),
            certificate.status,
          ]),
        ),
      );
      return undefined;
    },
  });

  parser.addCommand({
    name: "delete",
    description: "Soft-delete a certificate",
    options: [{ name: "name", type: "string", required: true, description: "Certificate name" }],
    handler: async (options) => {
      const name = requiredText(options, "name");
      const project = context.project();
      await context.confirm(`Delete certificate ${name}?`);
      const { client } = await context.client();
      await client.certificates.deleteCertificate({ project, name });
      context.render({ deleted: name }, (value) => `Deleted ${value.deleted}`);
      return undefined;
    },
  });

  return parser;
}

/** The certificate group definition. */
export const certGroup: CommandGroup = {
  name: "cert",
  summary: "Import, generate, read, list, and delete certificates",
  commands: ["import", "generate", "get", "list", "delete"],
  createParser: createCertParser,
};
