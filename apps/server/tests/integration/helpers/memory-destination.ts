import { Writable } from "node:stream";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Captures pino output for structured-log assertions. */
export class MemoryDestination extends Writable {
  readonly #chunks: string[] = [];

  public override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#chunks.push(chunk.toString("utf8"));
    callback();
  }

  /** Complete non-empty output lines. */
  public lines(): readonly string[] {
    return this.#chunks
      .join("")
      .split("\n")
      .filter((line) => line.length > 0);
  }

  /** Parsed JSON entries; non-JSON diagnostic lines are ignored. */
  public entries(): readonly Record<string, unknown>[] {
    const parsed: Record<string, unknown>[] = [];
    for (const line of this.lines()) {
      try {
        const value: unknown = JSON.parse(line);
        if (isRecord(value)) {
          parsed.push(value);
        }
      } catch {
        // Console output from WebAFX before the pino plugin is not JSON.
      }
    }
    return parsed;
  }
}
