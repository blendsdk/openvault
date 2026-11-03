import { z } from "zod";
import { ulidSchema } from "./ids.js";

/**
 * Agent-reported consumer metadata submitted during join and renewal.
 *
 * The server binds the identity and project from the token or authenticated
 * certificate. These fields describe the workload only and are never used as
 * authorization claims.
 */
export const agentConsumerSchema = z.strictObject({
  composeProject: z.string().min(1).max(100),
  composeService: z.string().min(1).max(100),
  hostname: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/),
  manifestHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

/**
 * Agent join request.
 *
 * The token is validated by the service so an in-bound malformed token maps to
 * authentication failure rather than a schema error. The CSR is parsed and
 * verified before the token is consumed.
 */
export const agentJoinRequestSchema = z.strictObject({
  token: z.string().min(1).max(128),
  csr: z.string().min(1).max(65_536),
  consumer: agentConsumerSchema,
});

/** Agent renewal request; the certificate authenticates the caller. */
export const agentRenewRequestSchema = z.strictObject({
  csr: z.string().min(1).max(65_536),
  consumer: agentConsumerSchema,
});

/** Certificate material returned by a successful join or renewal. */
export const agentCertificateResponseSchema = z.strictObject({
  certificatePem: z.string().min(1),
  chainPem: z.string().min(1),
  identityId: ulidSchema,
  serial: z.string().min(1).max(128),
  notAfter: z.iso.datetime(),
});

/** Inferred agent consumer metadata. */
export type AgentConsumer = z.infer<typeof agentConsumerSchema>;

/** Inferred agent join request. */
export type AgentJoinRequest = z.infer<typeof agentJoinRequestSchema>;

/** Inferred agent renewal request. */
export type AgentRenewRequest = z.infer<typeof agentRenewRequestSchema>;

/** Inferred agent certificate response. */
export type AgentCertificateResponse = z.infer<typeof agentCertificateResponseSchema>;
