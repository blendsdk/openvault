const MAX_RETURN_TO_LENGTH = 2048;

function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Sanitizes a post-login redirect to a same-origin path.
 *
 * Absolute URLs, protocol-relative URLs, backslashes, control characters, and
 * values longer than 2048 characters fall back to `/`. The resolved path and
 * query are returned; the origin is always the configured application origin.
 *
 * @param raw - Untrusted `returnTo` value.
 * @param baseUrl - Application base URL used to resolve the path.
 * @returns A safe path, or `/`.
 *
 * @example
 * ```ts
 * sanitizeReturnTo("/projects?tab=secrets", new URL("https://vault.example.com"));
 * // "/projects?tab=secrets"
 * ```
 */
export function sanitizeReturnTo(raw: unknown, baseUrl: URL): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RETURN_TO_LENGTH) {
    return "/";
  }
  if (
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("\\") ||
    hasUnsafeCharacter(raw)
  ) {
    return "/";
  }

  let resolved: URL;
  try {
    resolved = new URL(raw, baseUrl);
  } catch {
    return "/";
  }
  if (resolved.origin !== baseUrl.origin) {
    return "/";
  }
  return `${resolved.pathname}${resolved.search}`;
}
