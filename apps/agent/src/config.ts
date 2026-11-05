import { isAbsolute } from "node:path";
import { identityNameSchema, projectNameSchema } from "@openvault/api-contract";
import { z } from "zod";
import { AgentError } from "./errors.js";

/** Validated agent runtime configuration. */
export interface AgentConfig {
  /** Agent listener base URL. */
  readonly url: URL;
  /** PEM bundle used to verify the vault server. */
  readonly caFile: string;
  /** One-time join token, present only on first start. */
  readonly joinToken: string | undefined;
  /** OpenVault project name. */
  readonly project: string;
  /** OpenVault service identity name. */
  readonly service: string;
  /** Docker Compose project name. */
  readonly composeProject: string;
  /** Absolute manifest path. */
  readonly manifestPath: string;
  /** Absolute output directory inside the container. */
  readonly outputDir: string;
  /** Absolute state directory. */
  readonly stateDir: string;
  /** Absolute status file path. */
  readonly statusFile: string;
  /** Absolute unix socket path. */
  readonly socketPath: string;
}

const composeProjectSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "invalid Compose project name");
const joinTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "invalid join token");

/** Requires an absolute, non-empty path. */
function absolutePath(
  value: string | undefined,
  fallback: string | undefined,
  name: string,
): string {
  const resolved = value ?? fallback;
  if (resolved === undefined || resolved.length === 0 || !isAbsolute(resolved)) {
    throw new AgentError("agent_config_invalid", `${name} must be an absolute path`);
  }
  return resolved;
}

/**
 * Validates the agent environment.
 *
 * The manifest is not read here; project, service, and output agreement is
 * checked by the manifest loader. The join token is optional so a started
 * agent can reuse its stored certificate.
 *
 * @param env - Process environment.
 * @returns A frozen configuration.
 * @throws {AgentError} `agent_config_invalid` for any missing or invalid value.
 */
export function loadAgentConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const rawUrl = env.OPENVAULT_URL;
  if (rawUrl === undefined || rawUrl.length === 0) {
    throw new AgentError("agent_config_invalid", "OPENVAULT_URL is required");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AgentError("agent_config_invalid", "OPENVAULT_URL must be a valid URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new AgentError(
      "agent_config_invalid",
      "OPENVAULT_URL must be an HTTPS origin without credentials, path, query, or fragment",
    );
  }

  const project = projectNameSchema.safeParse(env.OPENVAULT_PROJECT);
  if (!project.success) {
    throw new AgentError("agent_config_invalid", "OPENVAULT_PROJECT is invalid");
  }
  const service = identityNameSchema.safeParse(env.OPENVAULT_SERVICE);
  if (!service.success) {
    throw new AgentError("agent_config_invalid", "OPENVAULT_SERVICE is invalid");
  }
  const composeProject = composeProjectSchema.safeParse(env.COMPOSE_PROJECT_NAME);
  if (!composeProject.success) {
    throw new AgentError("agent_config_invalid", "COMPOSE_PROJECT_NAME is invalid");
  }

  const caFile = env.OPENVAULT_CA_FILE;
  if (caFile === undefined || caFile.length === 0 || !isAbsolute(caFile)) {
    throw new AgentError("agent_config_invalid", "OPENVAULT_CA_FILE must be an absolute path");
  }

  let joinToken: string | undefined;
  if (env.OPENVAULT_JOIN_TOKEN !== undefined && env.OPENVAULT_JOIN_TOKEN.length > 0) {
    const parsed = joinTokenSchema.safeParse(env.OPENVAULT_JOIN_TOKEN);
    if (!parsed.success) {
      throw new AgentError("agent_config_invalid", "OPENVAULT_JOIN_TOKEN is invalid");
    }
    joinToken = parsed.data;
  }

  return Object.freeze({
    url,
    caFile,
    joinToken,
    project: project.data,
    service: service.data,
    composeProject: composeProject.data,
    manifestPath: absolutePath(
      env.OPENVAULT_MANIFEST,
      "/etc/openvault/manifest.yaml",
      "OPENVAULT_MANIFEST",
    ),
    outputDir: absolutePath(env.OPENVAULT_OUTPUT_DIR, "/run/secrets", "OPENVAULT_OUTPUT_DIR"),
    stateDir: absolutePath(env.OPENVAULT_STATE_DIR, "/var/lib/openvault", "OPENVAULT_STATE_DIR"),
    statusFile: absolutePath(
      env.OPENVAULT_STATUS_FILE,
      "/run/openvault/status.json",
      "OPENVAULT_STATUS_FILE",
    ),
    socketPath: absolutePath(
      env.OPENVAULT_SOCKET_PATH,
      "/run/openvault/agent.sock",
      "OPENVAULT_SOCKET_PATH",
    ),
  });
}
