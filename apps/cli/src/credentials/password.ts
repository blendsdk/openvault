import { CliError } from "../errors.js";
import type { CliRuntime } from "../types.js";

/** Maximum accepted password length. */
export const PASSWORD_MAX_LENGTH = 1024;

/** Options for {@link readPassword}. */
export interface ReadPasswordOptions {
  /** Standard input. */
  readonly stdin: CliRuntime["stdin"];
  /** Whether the input is an interactive terminal. */
  readonly isTty: boolean;
  /** Prompt written to stderr. */
  readonly prompt: string;
  /** Standard error writer. */
  readonly stderr: (text: string) => void;
}

/** Reads a password without echoing it. */
export async function readPassword(options: ReadPasswordOptions): Promise<string> {
  if (options.isTty && typeof options.stdin.setRawMode === "function") {
    return await readTtyPassword(options, options.stdin.setRawMode.bind(options.stdin));
  }
  return await readStreamPassword(options);
}

/** Reads one hidden line from a TTY. */
async function readTtyPassword(
  options: ReadPasswordOptions,
  setRawMode: (mode: boolean) => void,
): Promise<string> {
  options.stderr(options.prompt);
  setRawMode(true);
  options.stdin.resume?.();
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      options.stdin.removeListener("data", onData);
      setRawMode(false);
      options.stdin.pause?.();
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const character of text) {
        if (character === "\u0003") {
          cleanup();
          options.stderr("\n");
          reject(new CliError("cancelled", "Input cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          options.stderr("\n");
          try {
            resolve(validatePassword(value));
          } catch (error) {
            reject(error);
          }
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            options.stderr("\b \b");
          }
          continue;
        }
        if (value.length >= PASSWORD_MAX_LENGTH) {
          cleanup();
          options.stderr("\n");
          reject(new CliError("validation_error", "The password is too long", { exitCode: 2 }));
          return;
        }
        value += character;
      }
    };
    options.stdin.on("data", onData);
  });
}

/** Reads one line from a non-interactive stream. */
async function readStreamPassword(options: ReadPasswordOptions): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const cleanup = (): void => {
      options.stdin.removeListener("data", onData);
      options.stdin.removeListener("end", onEnd);
      options.stdin.removeListener("error", onError);
    };
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        resolve(validatePassword(value));
      } catch (error) {
        reject(error);
      }
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = text.indexOf("\n");
      value += newline === -1 ? text : text.slice(0, newline);
      if (value.length > PASSWORD_MAX_LENGTH) {
        settled = true;
        cleanup();
        reject(new CliError("validation_error", "The password is too long", { exitCode: 2 }));
        return;
      }
      if (newline !== -1) {
        finish();
      }
    };
    const onEnd = (): void => finish();
    const onError = (error: Error): void => {
      settled = true;
      cleanup();
      reject(new CliError("internal_error", "The password could not be read", { cause: error }));
    };
    options.stdin.on("data", onData);
    options.stdin.once("end", onEnd);
    options.stdin.once("error", onError);
    options.stdin.resume?.();
  });
}

/** Validates a password read from input. */
function validatePassword(value: string): string {
  const normalized = value.endsWith("\r") ? value.slice(0, -1) : value;
  if (normalized.length === 0) {
    throw new CliError("validation_error", "The password is required", { exitCode: 2 });
  }
  if (normalized.length > PASSWORD_MAX_LENGTH) {
    throw new CliError("validation_error", "The password is too long", { exitCode: 2 });
  }
  return normalized;
}
