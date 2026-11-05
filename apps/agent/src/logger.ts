import type { Writable } from "node:stream";

/** Structured, value-free log fields. */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

/** Minimal logger used by the agent runtime. */
export interface AgentLogger {
  /** Informational event. */
  info(event: string, fields?: LogFields): void;
  /** Degraded or retryable event. */
  warn(event: string, fields?: LogFields): void;
  /** Failure event. */
  error(event: string, fields?: LogFields): void;
}

/**
 * Creates a one-line JSON logger.
 *
 * The logger accepts only scalar fields supplied by the caller. Callers must
 * never pass values, file contents, PEM, tokens, response bodies, or raw error
 * text. Raw errors are mapped to a stable code before they reach this function.
 *
 * @param destination - Output stream; defaults to stderr.
 * @returns A structured logger.
 */
export function createAgentLogger(destination: Writable = process.stderr): AgentLogger {
  const write = (level: "info" | "warn" | "error", event: string, fields?: LogFields): void => {
    const record: Record<string, unknown> = { level, event, at: new Date().toISOString() };
    if (fields !== undefined) {
      for (const [key, value] of Object.entries(fields)) {
        record[key] = value;
      }
    }
    destination.write(`${JSON.stringify(record)}\n`);
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

/** A logger that discards every event; useful in tests and library use. */
export const silentAgentLogger: AgentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
