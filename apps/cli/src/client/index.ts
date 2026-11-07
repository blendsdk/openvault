import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { CliError } from "../errors.js";
import { type AuthenticatedClient, createAuthenticatedClient } from "./authenticated.js";

export { type AuthenticatedClient, createAuthenticatedClient } from "./authenticated.js";

import type { CredentialStore } from "../credentials/store.js";
import { HttpsAdapter } from "../transport/https-adapter.js";
import type { CliRuntime, GlobalOptions } from "../types.js";

/** Reads one CA bundle with a bound. */
export function readCaPem(path: string | undefined): string | undefined {
  if (path === undefined || path.length === 0) {
    return undefined;
  }
  if (!isAbsolute(path)) {
    throw new CliError("usage_error", "--ca must be an absolute path", { exitCode: 2 });
  }
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0 || stat.size > 1_048_576) {
      throw new Error("invalid CA file");
    }
    const pem = readFileSync(path, "utf8");
    if (!pem.includes("BEGIN CERTIFICATE")) {
      throw new Error("no certificate");
    }
    return pem;
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("tls_verification_failed", "The CA bundle could not be read", {
      cause: error,
    });
  }
}

/** Resolves the CA path from the explicit option or environment. */
export function caPathFor(globals: GlobalOptions, env: NodeJS.ProcessEnv): string | undefined {
  return globals.ca ?? env.OPENVAULT_CA_FILE;
}

/** Builds one transport for an explicit base URL. */
export function createTransport(
  baseUrl: string,
  globals: GlobalOptions,
  env: NodeJS.ProcessEnv,
): HttpsAdapter {
  return createTransportWithRuntime(baseUrl, globals, env);
}

/** Builds one transport with an optional verbose event sink. */
export function createTransportWithRuntime(
  baseUrl: string,
  globals: GlobalOptions,
  env: NodeJS.ProcessEnv,
  runtime?: CliRuntime,
): HttpsAdapter {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new CliError("usage_error", "The server URL is invalid", { exitCode: 2 });
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new CliError("usage_error", "The server URL must be an HTTPS origin", { exitCode: 2 });
  }
  const caPath = caPathFor(globals, env);
  const caPem = caPath === undefined ? undefined : readCaPem(caPath);
  const onRequest =
    runtime !== undefined && globals.verbose
      ? (event: import("../transport/https-adapter.js").RequestEvent): void => {
          runtime.stderr(`${JSON.stringify({ event: "request", ...event })}\n`);
        }
      : undefined;
  return new HttpsAdapter({
    baseUrl: url.href,
    ...(caPem === undefined ? {} : { caPem }),
    timeoutMs: globals.timeoutMs,
    ...(onRequest === undefined ? {} : { onRequest }),
  });
}

/**
 * Opens the authenticated client for one command.
 *
 * @param credentials - Credential store.
 * @param globals - Global options.
 * @param env - Process environment.
 * @returns The authenticated client.
 */
export function openAuthenticatedClient(
  credentials: CredentialStore,
  globals: GlobalOptions,
  env: NodeJS.ProcessEnv,
  runtime: CliRuntime,
): AuthenticatedClient {
  const document = credentials.load();
  if (document === undefined) {
    throw new CliError("authentication_required", "Run ov login", { exitCode: 3 });
  }
  const transport = createTransportWithRuntime(document.baseUrl, globals, env, runtime);
  return createAuthenticatedClient({
    credentials,
    transport,
    runtime,
    baseUrl: document.baseUrl,
  });
}
