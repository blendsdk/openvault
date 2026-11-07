/** Result of one credential copy or clipboard clear. */
export interface CredentialCopyResult {
  /** True when the operation completed. */
  readonly ok: boolean;
  /** Safe status text for the page. */
  readonly message: string;
}

type Listener = (result: CredentialCopyResult) => void;

const listeners = new Set<Listener>();
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

/** Sends one result to every mounted page. */
function notify(result: CredentialCopyResult): void {
  for (const listener of listeners) {
    listener(result);
  }
}

/**
 * Subscribes to credential-copy status updates.
 *
 * The subscription lives on the page, not in the token dialog, so a denied or
 * completed clear is still visible after the dialog closes.
 *
 * @param listener - Receives every copy and clear result.
 * @returns An unsubscribe function.
 */
export function subscribeCredentialCopy(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Copies one credential and schedules a best-effort clipboard clear.
 *
 * The previous pending clear is cancelled only after the new copy succeeds, so
 * a denied copy cannot leave an older sensitive value on the clipboard without
 * a timer. The clear is always attempted; a browser that refuses reports a
 * manual-clear instruction.
 *
 * @param value - Credential text to copy.
 * @param clearAfterMs - Delay before the clear attempt; defaults to 30 seconds.
 * @returns The initial copy result.
 */
export async function copyCredential(
  value: string,
  clearAfterMs = 30_000,
): Promise<CredentialCopyResult> {
  if (navigator.clipboard === undefined) {
    const result = { ok: false, message: "Clipboard unavailable; copy the token manually." };
    notify(result);
    return result;
  }
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const result = { ok: false, message: "The browser blocked clipboard access." };
    notify(result);
    return result;
  }

  if (pendingTimer !== undefined) {
    clearTimeout(pendingTimer);
  }
  const seconds = Math.round(clearAfterMs / 1_000);
  pendingTimer = setTimeout(() => {
    pendingTimer = undefined;
    if (navigator.clipboard === undefined) {
      notify({ ok: false, message: "Clipboard unavailable; clear the token manually." });
      return;
    }
    void navigator.clipboard.writeText("").then(
      () => notify({ ok: true, message: "Clipboard cleared." }),
      () =>
        notify({
          ok: false,
          message: "Copied token remains on the clipboard; clear it manually.",
        }),
    );
  }, clearAfterMs);

  const result = {
    ok: true,
    message: `Copied. The clipboard will be cleared in ${seconds} seconds if the browser allows.`,
  };
  notify(result);
  return result;
}

/**
 * Clears the shared timer and listeners.
 *
 * Tests use this to keep one credential copy from leaking into the next case.
 */
export function resetCredentialCopyForTest(): void {
  if (pendingTimer !== undefined) {
    clearTimeout(pendingTimer);
    pendingTimer = undefined;
  }
  listeners.clear();
}
