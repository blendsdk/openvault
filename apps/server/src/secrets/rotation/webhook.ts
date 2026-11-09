import { createHmac } from "node:crypto";

/** Payload delivered for one rotation warning. */
export interface RotationWebhookPayload {
  /** Stable event name. */
  readonly event: "secret.rotation_warning";
  /** Stable dedupe id: secret:version:status:dueAt. */
  readonly eventId: string;
  /** Secret identifier. */
  readonly secretId: string;
  /** Project identifier. */
  readonly projectId: string;
  /** Secret name. */
  readonly name: string;
  /** Version identifier. */
  readonly versionId: string;
  /** Derived due date. */
  readonly dueAt: string;
  /** Whole days until due; negative when overdue. */
  readonly daysUntilDue: number;
  /** Warning status. */
  readonly status: "due_soon" | "overdue";
  /** Delivery time. */
  readonly occurredAt: string;
}

/** Options for {@link SecretRotationWebhook}. */
export interface SecretRotationWebhookOptions {
  /** Absolute webhook URL. */
  readonly url: URL;
  /** Optional HMAC secret. */
  readonly secret?: string;
  /** Delivery timeout. */
  readonly timeoutMs?: number;
}

/**
 * Sends one rotation warning to an operator-configured endpoint.
 *
 * The payload contains public metadata only. When a secret is configured, the
 * `X-OpenVault-Signature` header is an HMAC over `<timestamp>.<rawBody>` and the
 * timestamp is sent in `X-OpenVault-Timestamp`.
 */
export class SecretRotationWebhook {
  readonly #url: URL;
  readonly #secret: string | undefined;
  readonly #timeoutMs: number;

  /**
   * @param options - URL, optional secret, and timeout.
   */
  public constructor(options: SecretRotationWebhookOptions) {
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
  public async send(payload: RotationWebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "openvault-rotation/1",
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
      throw new Error("Rotation webhook rejected the delivery");
    }
  }
}
