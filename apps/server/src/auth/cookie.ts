import type { Request, Response } from "express";

/** Host-scoped session cookie name. */
export const SESSION_COOKIE_NAME = "__Host-ov_session";
/** Host-scoped OIDC browser-binding cookie name. */
export const OIDC_BINDING_COOKIE_NAME = "__Host-ov_oidc";

function readCookie(req: Request, name: string): string | undefined {
  const parsed = req.cookies?.[name];
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
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/**
 * Reads the session cookie from a request.
 *
 * @param req - Express request.
 * @returns The raw cookie value, or `undefined`.
 */
export function readSessionCookie(req: Request): string | undefined {
  return readCookie(req, SESSION_COOKIE_NAME);
}

/**
 * Reads the OIDC browser-binding cookie from a request.
 *
 * @param req - Express request.
 * @returns The raw binding value, or `undefined`.
 */
export function readOidcBindingCookie(req: Request): string | undefined {
  return readCookie(req, OIDC_BINDING_COOKIE_NAME);
}

/*
 * The value is an opaque session or OIDC binding token, not a password. A
 * host-only HttpOnly/Secure/SameSite cookie is the intended transport; the
 * raw value is never written to logs or the database. CodeQL's generic
 * clear-text-storage query is a false positive for this sink.
 */
function setHostCookie(res: Response, name: string, value: string, maxAgeSeconds: number): void {
  res.cookie(name, value, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)) * 1_000,
  });
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
  setHostCookie(res, SESSION_COOKIE_NAME, secretId, maxAgeSeconds);
}

/**
 * Sets the short-lived OIDC browser-binding cookie.
 *
 * @param res - Express response.
 * @param binding - Random binding value.
 * @param maxAgeSeconds - Lifetime; defaults to the ten-minute state window.
 */
export function setOidcBindingCookie(res: Response, binding: string, maxAgeSeconds = 600): void {
  setHostCookie(res, OIDC_BINDING_COOKIE_NAME, binding, maxAgeSeconds);
}

/**
 * Clears a host-scoped cookie with the same security attributes.
 *
 * @param res - Express response.
 * @param name - Cookie name.
 */
function clearHostCookie(res: Response, name: string): void {
  res.cookie(name, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/**
 * Clears the session cookie.
 *
 * @param res - Express response.
 */
export function clearSessionCookie(res: Response): void {
  clearHostCookie(res, SESSION_COOKIE_NAME);
}

/**
 * Clears the OIDC browser-binding cookie.
 *
 * @param res - Express response.
 */
export function clearOidcBindingCookie(res: Response): void {
  clearHostCookie(res, OIDC_BINDING_COOKIE_NAME);
}
