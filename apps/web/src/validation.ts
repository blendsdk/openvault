/** Canonical project-name pattern shared with the API contract. */
export const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** Canonical secret-name pattern shared with the API contract. */
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,126}$/;

/** Validates one project name with a user-facing message. */
export function validateProjectName(value: string): string | undefined {
  if (!PROJECT_NAME_PATTERN.test(value)) {
    return "Use 3–40 lowercase letters, digits, or hyphens; start and end with a letter or digit.";
  }
  return undefined;
}

/** Validates one secret name with a user-facing message. */
export function validateSecretName(value: string): string | undefined {
  if (!SECRET_NAME_PATTERN.test(value)) {
    return "Start with a letter or digit; use letters, digits, or hyphens (1–127 characters).";
  }
  return undefined;
}

/** Parses `key=value` tag lines into a tag record. */
export function parseTagLines(value: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      throw new Error("Tags must use key=value, one per line");
    }
    const key = trimmed.slice(0, separator).trim();
    const tagValue = trimmed.slice(separator + 1).trim();
    if (key.length === 0) {
      throw new Error("Tag keys cannot be empty");
    }
    if (Object.hasOwn(tags, key)) {
      throw new Error(`Duplicate tag key: ${key}`);
    }
    tags[key] = tagValue;
  }
  return tags;
}

/** Formats a tag record as editable lines. */
export function formatTagLines(tags: Readonly<Record<string, string>>): string {
  return Object.entries(tags)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}
