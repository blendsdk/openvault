import type { AdapterRequest, AdapterResponse, RequestAdapter } from "blendsdk/api-client";
import { FetchAdapter } from "blendsdk/api-client";
import { useAuth } from "blendsdk/react";
import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createOpenVaultWebClient, type OpenVaultWebClient } from "../generated/index.js";
import { CsrfCookieAuth, type CsrfSessionSource } from "./csrf-cookie-auth.js";

/** The API value shared by every screen. */
export interface SessionApi {
  /** Generated browser client. */
  readonly client: OpenVaultWebClient;
  /** Current CSRF token, or null before the first session check. */
  readonly csrfToken: string | null;
  /** Refreshes the session; used by retry actions. */
  readonly refresh: () => Promise<boolean>;
}

/**
 * The session API context.
 *
 * Exported so tests can provide a stub client without mounting the real auth
 * provider. Production code uses `SessionApiProvider`.
 */
export const SessionApiContext = createContext<SessionApi | null>(null);

/**
 * Creates the generated browser client and keeps its CSRF token current.
 *
 * The client is created once. A mutable source is read by the auth strategy on
 * every request, so token rotation never leaves a stale header. The source's
 * refresh waits for the new token to reach the mirror before the runtime
 * retries the failed request.
 */
export function SessionApiProvider({ children }: { readonly children: ReactNode }) {
  const auth = useAuth();
  const tokenRef = useRef<string | null>(auth.csrfToken);
  const logoutRef = useRef(auth.logout);
  logoutRef.current = auth.logout;

  useEffect(() => {
    tokenRef.current = auth.csrfToken;
  }, [auth.csrfToken]);

  /**
   * Rotates the browser session with the current CSRF token.
   *
   * This deliberately does not use the SDK refresh: the SDK treats `expiresAt`
   * as Unix seconds while the server contract uses ISO timestamps. Owning the
   * refresh keeps the token mirror and the schedule in one unit.
   */
  const refreshSession = useCallback(async (): Promise<boolean> => {
    const token = tokenRef.current;
    try {
      const response = await fetch("/v1/auth/refresh", {
        method: "POST",
        credentials: "include",
        headers: token === null ? {} : { "x-csrf-token": token },
      });
      if (!response.ok) {
        return false;
      }
      const body = (await response.json()) as { data?: { csrfToken?: unknown } };
      const next = body.data?.csrfToken;
      if (typeof next !== "string" || next.length === 0) {
        return false;
      }
      tokenRef.current = next;
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Re-reads `/me` after another tab rotated the CSRF token. */
  const recoverSession = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch("/v1/auth/me", { credentials: "include" });
      if (!response.ok) {
        return false;
      }
      const body = (await response.json()) as { data?: { csrfToken?: unknown } };
      const next = body.data?.csrfToken;
      if (typeof next !== "string" || next.length === 0) {
        return false;
      }
      tokenRef.current = next;
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Returns false only when the server confirms the session is gone. */
  const sessionAlive = useCallback(async (): Promise<boolean | undefined> => {
    try {
      const response = await fetch("/v1/auth/me", { credentials: "include" });
      if (response.status === 401) {
        return false;
      }
      if (!response.ok) {
        return undefined;
      }
      const body = (await response.json()) as { data?: { csrfToken?: unknown } };
      const next = body.data?.csrfToken;
      if (typeof next === "string" && next.length > 0) {
        tokenRef.current = next;
      }
      return true;
    } catch {
      return undefined;
    }
  }, []);

  const [client] = useState(() => {
    const source: CsrfSessionSource = {
      currentToken: () => tokenRef.current,
      refresh: refreshSession,
    };
    const csrfAuth = new CsrfCookieAuth(source);
    const fetchAdapter = new FetchAdapter();
    const adapter: RequestAdapter = {
      send: async (request: AdapterRequest): Promise<AdapterResponse> => {
        let response = await fetchAdapter.send(request);
        if (response.status === 403 && isCsrfInvalid(response.body)) {
          if (await recoverSession()) {
            const retried = await csrfAuth.apply(request);
            response = await fetchAdapter.send(retried);
          }
        }
        return response;
      },
    };
    return createOpenVaultWebClient({
      baseUrl: "",
      adapter,
      auth: csrfAuth,
      headers: { "User-Agent": "openvault-web/1.2.0" },
    });
  });

  useEffect(() => {
    if (!auth.isAuthenticated) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (expiresAt: string): void => {
      const expires = Date.parse(expiresAt);
      if (!Number.isFinite(expires)) {
        return;
      }
      const delay = Math.max(30_000, expires - Date.now() - 60_000);
      timer = setTimeout(() => {
        void (async () => {
          if (cancelled) {
            return;
          }
          let refreshed = await refreshSession();
          if (!refreshed && !cancelled) {
            // Another tab may have rotated the CSRF token. Recover once, then
            // treat a failed refresh as an expired session.
            if (await recoverSession()) {
              refreshed = await refreshSession();
            }
          }
          if (!refreshed) {
            if (!cancelled && (await sessionAlive()) === false) {
              await logoutRef.current();
            }
            return;
          }
          try {
            const me = await client.session.getMe();
            if (!cancelled) {
              schedule(me.expiresAt);
            }
          } catch {
            // A later request or sign-in will recover the session.
          }
        })();
      }, delay);
    };
    void (async () => {
      try {
        const me = await client.session.getMe();
        if (cancelled) {
          return;
        }
        tokenRef.current = me.csrfToken;
        schedule(me.expiresAt);
      } catch {
        // The API guard handles an expired session.
      }
    })();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [auth.isAuthenticated, client, refreshSession, recoverSession, sessionAlive]);

  const value = useMemo<SessionApi>(
    () => ({
      client,
      csrfToken: tokenRef.current,
      refresh: refreshSession,
    }),
    [client, refreshSession],
  );

  return <SessionApiContext.Provider value={value}>{children}</SessionApiContext.Provider>;
}

/** Returns true when a response is the server's CSRF rejection. */
function isCsrfInvalid(body: unknown): boolean {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const error = Reflect.get(body, "error");
  return (
    typeof error === "object" && error !== null && Reflect.get(error, "code") === "csrf_invalid"
  );
}

/** Returns the API value. Throws when used outside the provider. */
export function useSessionApi(): SessionApi {
  const value = useContext(SessionApiContext);
  if (value === null) {
    throw new Error("useSessionApi must be used inside SessionApiProvider");
  }
  return value;
}
