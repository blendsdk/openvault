/** Maximum attempts for one certificate insert with a generated serial. */
export const CERTIFICATE_ATTEMPTS = 3;

/**
 * Reports whether an error is a unique-constraint collision on certificate
 * identity columns.
 *
 * A new serial or fingerprint is generated for each attempt, so a collision is
 * safe to retry. Any other database error must propagate unchanged.
 *
 * @param error - Error thrown by the insert.
 * @returns True for a serial or fingerprint collision.
 */
export function isCertificateConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = Reflect.get(error, "code");
  const constraint = Reflect.get(error, "constraint");
  return (
    code === "23505" &&
    typeof constraint === "string" &&
    (constraint.includes("workload_certs_serial") ||
      constraint.includes("workload_certs_fingerprint"))
  );
}
