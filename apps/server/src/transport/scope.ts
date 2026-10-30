import { BadRequestError, NotFoundError } from "blendsdk/webafx";
import type { RequestHandler } from "express";

/** Listener whose routing table is being enforced. */
export type ListenerKind = "admin" | "agent";

const listenerKinds = new WeakMap<object, ListenerKind>();

function hasUnsafePathCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || character === "\\") {
      return true;
    }
  }
  return false;
}

/**
 * Marks the request with the listener that accepted it.
 *
 * The server wrapper calls this before Express handles the request. A client
 * cannot set this value because it never crosses the HTTP boundary.
 */
export function markListener(request: object, listener: ListenerKind): void {
  listenerKinds.set(request, listener);
}

/** Returns the listener marker, or `undefined` when the request was not marked. */
export function listenerOf(request: object): ListenerKind | undefined {
  return listenerKinds.get(request);
}

/**
 * Normalises a request path for scope decisions.
 *
 * The value is decoded once, duplicate slashes are collapsed, the result is
 * lowercased, and a trailing slash is removed. Absolute-form request targets are
 * reduced to their pathname. Malformed encodings and control characters are
 * rejected before routing.
 *
 * @param raw - `req.originalUrl` or `req.url`.
 * @returns The normalised path used only for security decisions.
 * @throws {BadRequestError} When the path is not a valid, decodable pathname.
 */
export function normalizeRequestPath(raw: string | undefined): string {
  let value = raw === undefined || raw.length === 0 ? "/" : raw;

  if (/^https?:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      throw new BadRequestError("Malformed request path");
    }
  } else {
    const queryIndex = value.indexOf("?");
    if (queryIndex >= 0) {
      value = value.slice(0, queryIndex);
    }
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new BadRequestError("Malformed request path");
  }
  if (!decoded.startsWith("/") || hasUnsafePathCharacters(decoded)) {
    throw new BadRequestError("Malformed request path");
  }

  const collapsed = decoded.replace(/\/{2,}/g, "/").toLowerCase();
  const segments = collapsed.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new BadRequestError("Malformed request path");
  }
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

/**
 * Applies the default-deny listener scope table.
 *
 * Admin permits liveness, readiness, and the non-agent API. Agent permits
 * liveness and agent routes only.
 */
export function isAllowedPath(listener: ListenerKind, path: string): boolean {
  if (listener === "admin") {
    if (path === "/health" || path === "/ready" || path === "/v1") {
      return true;
    }
    return path.startsWith("/v1/") && path !== "/v1/agent" && !path.startsWith("/v1/agent/");
  }
  return path === "/health" || path === "/v1/agent" || path.startsWith("/v1/agent/");
}

/**
 * Creates the scope middleware for one listener.
 *
 * The original request is left untouched for WebAFX routing and diagnostics;
 * only the decision uses the normalised form.
 */
export function createScopeMiddleware(): RequestHandler {
  return (req, _res, next) => {
    try {
      const listener = listenerOf(req);
      if (listener === undefined) {
        throw new NotFoundError("Not Found");
      }
      const path = normalizeRequestPath(req.originalUrl || req.url);
      if (!isAllowedPath(listener, path)) {
        throw new NotFoundError("Not Found");
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
