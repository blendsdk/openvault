/** Maximum accepted clock difference for token and certificate validation. */
export const CLOCK_SKEW_SECONDS = 30;

/**
 * Reports whether `nowMs` falls inside a validity window with 30 seconds of
 * early/late tolerance.
 *
 * The boundary is inclusive: exactly 30 seconds outside the window is accepted,
 * and one millisecond beyond is rejected.
 *
 * @param nowMs - Injected current time in milliseconds.
 * @param notBeforeMs - Start of the validity window.
 * @param notAfterMs - End of the validity window.
 * @returns `true` when the value is within the tolerated window.
 */
export function isWithinClockSkew(nowMs: number, notBeforeMs: number, notAfterMs: number): boolean {
  const toleranceMs = CLOCK_SKEW_SECONDS * 1_000;
  return nowMs >= notBeforeMs - toleranceMs && nowMs <= notAfterMs + toleranceMs;
}
