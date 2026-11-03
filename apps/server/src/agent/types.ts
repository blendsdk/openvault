/**
 * Authenticated agent request context.
 *
 * Every field is derived from the verified TLS peer certificate and one live
 * database row. Path or body values never contribute to these claims.
 */
export interface AgentAuthContext {
  /** Discriminator for request-context guards. */
  readonly kind: "agent";
  /** Service principal identifier. */
  readonly principalId: string;
  /** Owner project identifier. */
  readonly projectId: string;
  /** Owner project name used by the data-route guard. */
  readonly projectName: string;
  /** Workload certificate row identifier. */
  readonly certificateId: string;
  /** Certificate serial. */
  readonly serial: string;
  /** Lowercase SHA-256 of the certificate DER. */
  readonly fingerprint: string;
  /** Lowercase SHA-256 of the certificate SubjectPublicKeyInfo DER. */
  readonly publicKeySha256: string;
  /** Certificate expiry in milliseconds since the Unix epoch. */
  readonly notAfter: number;
}
