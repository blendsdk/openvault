import { type AuthenticatedClient, openAuthenticatedClient } from "../client/index.js";
import { CredentialStore } from "../credentials/store.js";
import { CliError } from "../errors.js";
import { writeSuccess } from "../output.js";
import type { CliRuntime, GlobalOptions } from "../types.js";

/** Per-invocation command context. */
export interface CommandContext {
  /** Parsed global options. */
  readonly globals: GlobalOptions;
  /** Process boundary. */
  readonly runtime: CliRuntime;
  /** Credential store, constructed only when needed. */
  readonly credentials: CredentialStore;
  /** Opens the authenticated client on first use. */
  client(): Promise<AuthenticatedClient>;
  /** Writes a human or JSON success result. */
  render<T>(data: T, human: (value: T) => string): void;
  /** Requires the global project context. */
  project(): string;
  /** Confirms a destructive action. */
  confirm(message: string): Promise<void>;
  /** Writes one verbose request event. */
  verbose(fields: Readonly<Record<string, string | number | boolean>>): void;
}

/** Reads one confirmation line from the runtime input. */
async function readConfirmation(runtime: CliRuntime, prompt: string): Promise<string> {
  runtime.stderr(prompt);
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      runtime.stdin.removeListener("data", onData);
      runtime.stdin.removeListener("error", onError);
      runtime.stdin.pause?.();
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = text.indexOf("\n");
      value += newline === -1 ? text : text.slice(0, newline);
      if (value.length > 32) {
        cleanup();
        reject(new CliError("validation_error", "Confirmation is too long", { exitCode: 2 }));
        return;
      }
      if (newline !== -1) {
        cleanup();
        resolve(value.trim().toLowerCase());
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new CliError("internal_error", "Confirmation could not be read", { cause: error }));
    };
    const onEnd = (): void => {
      cleanup();
      resolve("");
    };
    runtime.stdin.on("data", onData);
    runtime.stdin.once("end", onEnd);
    runtime.stdin.once("error", onError);
    runtime.stdin.resume?.();
  });
}

/** Reads one visible line from the runtime input. */
export async function readVisibleLine(runtime: CliRuntime, prompt: string): Promise<string> {
  runtime.stderr(prompt);
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const cleanup = (): void => {
      runtime.stdin.removeListener("data", onData);
      runtime.stdin.removeListener("end", onEnd);
      runtime.stdin.removeListener("error", onError);
      runtime.stdin.pause?.();
    };
    const fail = (error: CliError): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const finish = (): void => {
      if (settled) {
        return;
      }
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        fail(new CliError("validation_error", "The identifier is required", { exitCode: 2 }));
        return;
      }
      settled = true;
      cleanup();
      resolve(trimmed);
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = text.indexOf("\n");
      value += newline === -1 ? text : text.slice(0, newline);
      if (value.length > 320) {
        fail(new CliError("validation_error", "Input is too long", { exitCode: 2 }));
        return;
      }
      if (newline !== -1) {
        finish();
      }
    };
    const onEnd = (): void => finish();
    const onError = (error: Error): void => {
      fail(new CliError("internal_error", "Input could not be read", { cause: error }));
    };
    runtime.stdin.on("data", onData);
    runtime.stdin.once("end", onEnd);
    runtime.stdin.once("error", onError);
    runtime.stdin.resume?.();
  });
}

/**
 * Creates the per-invocation command context.
 *
 * @param globals - Parsed global options.
 * @param runtime - Process boundary.
 * @returns The command context.
 */
export function createCommandContext(globals: GlobalOptions, runtime: CliRuntime): CommandContext {
  let store: CredentialStore | undefined;
  let clientPromise: Promise<AuthenticatedClient> | undefined;
  const credentials = (): CredentialStore => {
    store ??= new CredentialStore({ env: runtime.env });
    return store;
  };
  return {
    globals,
    runtime,
    get credentials(): CredentialStore {
      return credentials();
    },
    async client(): Promise<AuthenticatedClient> {
      clientPromise ??= Promise.resolve(
        openAuthenticatedClient(credentials(), globals, runtime.env, runtime),
      );
      return await clientPromise;
    },
    render<T>(data: T, human: (value: T) => string): void {
      writeSuccess(runtime, globals, data, human);
    },
    project(): string {
      if (globals.project === undefined || globals.project.length === 0) {
        throw new CliError("usage_error", "--project is required", { exitCode: 2 });
      }
      return globals.project;
    },
    async confirm(message: string): Promise<void> {
      if (globals.yes) {
        return;
      }
      if (!runtime.isTty) {
        throw new CliError(
          "confirmation_required",
          "This command needs --yes in a non-interactive session",
          { exitCode: 2 },
        );
      }
      const answer = await readConfirmation(runtime, `${message} [y/N] `);
      if (answer !== "y" && answer !== "yes") {
        throw new CliError("cancelled", "Aborted", { exitCode: 1 });
      }
    },
    verbose(fields): void {
      if (!globals.verbose) {
        return;
      }
      runtime.stderr(`${JSON.stringify({ event: "request", ...fields })}\n`);
    },
  };
}
