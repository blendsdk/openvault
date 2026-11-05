import { Badge } from "@fluentui/react-components";
import {
  CheckmarkCircle20Filled,
  DismissCircle20Filled,
  Warning20Filled,
} from "@fluentui/react-icons";

/** Status values used across the UI. */
export type UiStatus = "active" | "deleted" | "disabled" | "expired" | "ok" | "degraded" | "failed";

/** Text-and-icon status; color is never the only signal. */
export function StatusBadge({
  status,
  label,
}: {
  readonly status: UiStatus;
  readonly label?: string;
}) {
  const icon =
    status === "active" || status === "ok" ? (
      <CheckmarkCircle20Filled aria-hidden="true" />
    ) : status === "degraded" ? (
      <Warning20Filled aria-hidden="true" />
    ) : (
      <DismissCircle20Filled aria-hidden="true" />
    );
  const color =
    status === "active" || status === "ok"
      ? "success"
      : status === "degraded" || status === "expired"
        ? "warning"
        : "danger";
  return (
    <Badge appearance="tint" color={color} icon={icon}>
      {label ?? status}
    </Badge>
  );
}

/** Formats one ISO timestamp for display. */
export function formatTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/**
 * Renders an unknown API value as text.
 *
 * The generated client types nullable identifiers as `unknown` because the
 * source schema allows a null variant the generator cannot narrow. This helper
 * never guesses: only strings, numbers, and booleans become text.
 */
export function asText(value: unknown): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "—";
}

/** Renders an unknown value or a fallback label. */
export function asTextOr(value: unknown, fallback: string): string {
  const text = asText(value);
  return text === "—" ? fallback : text;
}

/** Formats one tag record as a compact string. */
export function formatTags(tags: Readonly<Record<string, string>>): string {
  const entries = Object.entries(tags);
  return entries.length === 0 ? "—" : entries.map(([key, value]) => `${key}=${value}`).join(", ");
}
