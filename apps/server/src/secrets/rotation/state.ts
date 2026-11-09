/** Milliseconds in one UTC day. */
export const DAY_MS = 86_400_000;

/** One rotation status computed from the current version and policy. */
export type RotationStatus = "ok" | "due_soon" | "overdue";

/**
 * Derives the next rotation due date from the current version.
 *
 * The due date is intentionally not stored. Writing a new version moves the
 * current-version timestamp and therefore starts the next interval.
 *
 * @param createdAt - Current version creation time.
 * @param intervalDays - Configured interval, or null when no policy exists.
 * @returns The due date, or null when there is no policy or current version.
 */
export function rotationDueAt(createdAt: Date | null, intervalDays: number | null): Date | null {
  if (createdAt === null || intervalDays === null) {
    return null;
  }
  return new Date(createdAt.getTime() + intervalDays * DAY_MS);
}

/**
 * Computes the live rotation status.
 *
 * The boundary is inclusive on the warning and due instants: at exactly
 * `dueAt - warningDays` the status is due soon, and at exactly `dueAt` it is
 * overdue.
 *
 * @param dueAt - Derived due date, or null.
 * @param now - Current time in milliseconds since the Unix epoch.
 * @param warningDays - Due-soon window in days.
 * @returns The status, or null when no policy exists.
 */
export function rotationState(
  dueAt: Date | null,
  now: number,
  warningDays: number,
): RotationStatus | null {
  if (dueAt === null) {
    return null;
  }
  if (now >= dueAt.getTime()) {
    return "overdue";
  }
  if (now >= dueAt.getTime() - warningDays * DAY_MS) {
    return "due_soon";
  }
  return "ok";
}

/**
 * Counts whole days from now to the due date.
 *
 * Due-soon values round up so a secret seven days minus one millisecond away
 * still reports seven days. Overdue values round down so any overdue time is
 * negative; the exact due instant is zero.
 *
 * @param dueAt - Due date.
 * @param now - Current time in milliseconds since the Unix epoch.
 * @returns Whole days, positive before the due date and negative after it.
 */
export function daysUntilDue(dueAt: Date, now: number): number {
  const remaining = dueAt.getTime() - now;
  return remaining >= 0 ? Math.ceil(remaining / DAY_MS) : Math.floor(remaining / DAY_MS);
}
