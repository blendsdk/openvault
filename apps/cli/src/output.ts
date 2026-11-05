import type { CliError } from "./errors.js";
import type { CliRuntime, GlobalOptions } from "./types.js";

/** Escapes terminal control characters in one table cell. */
export function escapeTerminal(value: string): string {
  return value.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the target
    /[\u0000-\u001f\u007f-\u009f]/g,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

/** Formats one simple two-space table. */
export function formatTable(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => escapeTerminal(cell).padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [line(headers), separator, ...rows.map(line)].join("\n");
}

/** Writes one successful result. */
export function writeSuccess<T>(
  runtime: CliRuntime,
  globals: GlobalOptions,
  data: T,
  human: (value: T) => string,
): void {
  if (globals.json) {
    runtime.stdout(`${JSON.stringify({ success: true, data })}\n`);
    return;
  }
  const text = human(data);
  runtime.stdout(text.endsWith("\n") ? text : `${text}\n`);
}

/** Writes one failure to stderr. */
export function writeFailure(runtime: CliRuntime, globals: GlobalOptions, error: CliError): void {
  if (globals.json) {
    runtime.stderr(
      `${JSON.stringify({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
        },
      })}\n`,
    );
    return;
  }
  const request = error.requestId === undefined ? "" : ` (request ${error.requestId})`;
  runtime.stderr(`${error.code}: ${error.message}${request}\n`);
}

/** Formats one date for a table. */
export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace(".000Z", "Z") : value;
}
