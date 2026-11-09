/** Encodes bytes as unpadded base64url. */
export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Generates a 32-byte random value encoded as base64url.
 *
 * The value exists only in the caller's memory. Callers must show it once and
 * must not persist it in browser storage, the URL, a log, or the console.
 *
 * @returns A 43-character base64url value.
 */
export function generateSecretValue(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}
