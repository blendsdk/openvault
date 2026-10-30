import type { Request, Response } from "express";

/** Host-scoped session cookie name. */
export const SESSION_COOKIE_NAME = "__Host-ov_session";

/**
 * Reads the session cookie from a request.
 *
 * The parsed `req.cookies` object is used when cookie-parser is installed. A
 * small header fallback keeps the helper usable in focused tests and if the
 * middleware order changes.
 *
 * @param req - Express request.
 * @returns The raw cookie value, or `undefined`.
 */
export function readSessionCookie(req: Request): string | undefined {
  const parsed = req.cookies?.[SESSION_COOKIE_NAME];
  if (typeof parsed === "string") {
    return parsed;
  }
  if (Array.isArray(parsed) && typeof parsed[0] === "string") {
    return parsed[0];
  }

  const header = req.headers.cookie;
  if (typeof header !== "string") {
    return undefined;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === SESSION_COOKIE_NAME) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/**
 * Sets the hardened session cookie.
 *
 * `__Host-` requires `Secure`, `Path=/`, and no `Domain`; all three are set
 * explicitly. `Max-Age` is expressed in seconds at this boundary and converted
 * to the millisecond value Express expects.
 *
 * @param res - Express response.
 * @param secretId - Secret session value.
 * @param maxAgeSeconds - Remaining lifetime in seconds.
 */
export function setSessionCookie(res: Response, secretId: string, maxAgeSeconds: number): void {
  res.cookie(SESSION_COOKIE_NAME, secretId, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)) * 1_000,
  });
}

/**
 * Clears the session cookie with the same security attributes.
 *
 * @param res - Express response.
 */
export function clearSessionCookie(res: Response): void {
  res.cookie(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
