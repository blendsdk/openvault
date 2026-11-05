import { createHmac } from "node:crypto";

/** Payload delivered for one expiry threshold. */
export interface ExpiryWebhookPayload {
  /** Stable event name. */
  readonly event: "certificate.expiry_warning";
  /** Stable dedupe id: certificate:version:threshold. */
  readonly eventId: string;
  /** Certificate identifier. */
  readonly certificateId: string;
  /** Project identifier. */
  readonly projectId: string;
  /** Certificate name. */
  readonly name: string;
  /** Version identifier. */
  readonly versionId: string;
  /** Leaf fingerprint. */
  readonly fingerprint: string;
  /** Validity end. */
  readonly notAfter: string;
  /** Days remaining. */
  readonly daysToExpiry: number;
  /** Threshold that fired. */
  readonly thresholdDays: number;
  /** Delivery time. */
  readonly occurredAt: string;
}

/** Options for {@link CertificateExpiryWebhook}. */
export interface CertificateExpiryWebhookOptions {
  /** Absolute webhook URL. */
  readonly url: URL;
  /** Optional HMAC secret. */
  readonly secret?: string;
  /** Delivery timeout. */
  readonly timeoutMs?: number;
}

/**
 * Sends one expiry warning to an operator-configured HTTPS endpoint.
 *
 * The payload contains public metadata only. When a secret is configured, the
 * `X-OpenVault-Signature` header is an HMAC over `<timestamp>.<rawBody>` and the timestamp is
 * sent in `X-OpenVault-Timestamp` for replay rejection.
 */
export class CertificateExpiryWebhook {
  readonly #url: URL;
  readonly #secret: string | undefined;
  readonly #timeoutMs: number;

  /**
   * @param options - URL, optional secret, and timeout.
   */
  public constructor(options: CertificateExpiryWebhookOptions) {
    this.#url = options.url;
    this.#secret = options.secret;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  /**
   * Delivers one payload.
   *
   * @param payload - Public warning metadata.
   * @throws {Error} When the endpoint is unreachable or returns a non-2xx status.
   */
  public async send(payload: ExpiryWebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "openvault-expiry/1",
      "x-openvault-timestamp": payload.occurredAt,
    };
    if (this.#secret !== undefined) {
      headers["x-openvault-signature"] = `sha256=${createHmac("sha256", this.#secret)
        .update(`${payload.occurredAt}.${body}`, "utf8")
        .digest("hex")}`;
    }
    const response = await fetch(this.#url, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) {
      throw new Error("Expiry webhook rejected the delivery");
    }
  }
}
