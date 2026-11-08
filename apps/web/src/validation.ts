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

/** Validates one certificate name with a user-facing message. */
export function validateCertificateName(value: string): string | undefined {
  return validateSecretName(value);
}

/**
 * Validates a certificate subject distinguished name.
 *
 * The server performs the full RFC 4514 parse; this check catches the common
 * mistakes before a request: an empty value, a missing `=`, control
 * characters, or a value that exceeds the contract bound.
 *
 * @param value - Subject text entered in a form.
 * @returns A user-facing error, or undefined when the shape is plausible.
 */
export function parseSubject(value: string): string | undefined {
  if (value.length === 0) {
    return "Enter a subject distinguished name";
  }
  if (value.length > 1_024) {
    return "Use at most 1,024 characters";
  }
  if (/\p{Cc}/u.test(value)) {
    return "Control characters are not allowed";
  }
  if (!value.includes("=")) {
    return "Use an RFC 4514 name such as CN=api.example.com";
  }
  return undefined;
}

/** One typed SAN prefix accepted by the certificate contract. */
const SAN_PREFIX = /^(DNS|IP|URI|email):/;

/**
 * Parses one typed SAN per line.
 *
 * Blank lines are ignored. The parser enforces the contract bounds and the
 * typed prefix so an operator gets immediate feedback; the server remains the
 * authority for DNS, IP, URI, and email syntax.
 *
 * @param value - Textarea contents with one SAN per line.
 * @returns Parsed SANs, or an error with an empty list.
 */
export function parseSans(value: string): { readonly sans: string[]; readonly error?: string } {
  const sans = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (sans.length === 0) {
    return { sans: [], error: "Add at least one SAN" };
  }
  if (sans.length > 100) {
    return { sans: [], error: "Use at most 100 SANs" };
  }
  for (const san of sans) {
    if (san.length > 2_048) {
      return { sans: [], error: "Each SAN must be at most 2,048 characters" };
    }
    if (/\p{Cc}/u.test(san)) {
      return { sans: [], error: "Control characters are not allowed" };
    }
    if (!SAN_PREFIX.test(san)) {
      return { sans: [], error: "Each SAN must start with DNS:, IP:, URI:, or email:" };
    }
    if (san.slice(san.indexOf(":") + 1).trim().length === 0) {
      return { sans: [], error: "Each SAN needs a value after its prefix" };
    }
  }
  return { sans };
}

/**
 * Parses a validity period in whole days.
 *
 * @param value - Raw number-input text.
 * @returns The day count and an error when the value is outside 1–825.
 */
export function parseValidityDays(value: string): {
  readonly days: number;
  readonly error?: string;
} {
  if (!/^\d+$/.test(value.trim())) {
    return { days: 0, error: "Enter a whole number of days" };
  }
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > 825) {
    return { days: 0, error: "Use between 1 and 825 days" };
  }
  return { days };
}

/** Parses a date input value into its local calendar parts. */
function parseDateInput(value: string): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return undefined;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

/**
 * Converts a `YYYY-MM-DD` input to the local start of that day.
 *
 * The list filter sends timestamps, so the browser and the operator must agree
 * on the calendar day. Building the date in local time and serializing with
 * `toISOString` preserves the visible day in the query.
 *
 * @param value - Date input value.
 * @returns An ISO timestamp, or the original value when it is not a date.
 */
export function startOfDayIso(value: string): string {
  const parts = parseDateInput(value);
  if (parts === undefined) {
    return value;
  }
  return new Date(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0).toISOString();
}

/**
 * Converts a `YYYY-MM-DD` input to the local end of that day.
 *
 * @param value - Date input value.
 * @returns An ISO timestamp, or the original value when it is not a date.
 */
export function endOfDayIso(value: string): string {
  const parts = parseDateInput(value);
  if (parts === undefined) {
    return value;
  }
  return new Date(parts.year, parts.month - 1, parts.day, 23, 59, 59, 999).toISOString();
}
