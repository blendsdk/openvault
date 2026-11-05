import { CliError } from "../errors.js";

/** Returns one string option. */
export function textOption(options: Record<string, unknown>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

/** Returns one required string option. */
export function requiredText(options: Record<string, unknown>, name: string): string {
  const value = textOption(options, name);
  if (value === undefined || value.length === 0) {
    throw new CliError("usage_error", `--${name} is required`, { exitCode: 2 });
  }
  return value;
}

/** Returns one boolean option. */
export function flagOption(options: Record<string, unknown>, name: string): boolean {
  return options[name] === true;
}

/** Returns one repeated string option. */
export function textList(options: Record<string, unknown>, name: string): string[] {
  const value = options[name];
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  throw new CliError("usage_error", `--${name} must be a string`, { exitCode: 2 });
}

/** Returns one integer option. */
export function numberOption(options: Record<string, unknown>, name: string): number | undefined {
  const value = options[name];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** Parses repeated `key=value` tags. */
export function parseTags(values: readonly string[]): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new CliError("validation_error", "--tag must be key=value", { exitCode: 2 });
    }
    const key = value.slice(0, separator);
    const tagValue = value.slice(separator + 1);
    if (Object.hasOwn(tags, key)) {
      throw new CliError("validation_error", `Duplicate tag key: ${key}`, { exitCode: 2 });
    }
    // Biome flags literal control-character ranges; matching them is the point here.
    if (
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the target
      /[\u0000-\u001f\u007f-\u009f]/u.test(key) ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the target
      /[\u0000-\u001f\u007f-\u009f]/u.test(tagValue)
    ) {
      throw new CliError("validation_error", "Tags cannot contain control characters", {
        exitCode: 2,
      });
    }
    tags[key] = tagValue;
  }
  if (Object.keys(tags).length > 15) {
    throw new CliError("validation_error", "At most fifteen tags are allowed", { exitCode: 2 });
  }
  return tags;
}
