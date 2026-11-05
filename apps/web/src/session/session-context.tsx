import type { AuthUser } from "blendsdk/react";
import { useAuth } from "blendsdk/react";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";

/** The session surface the application consumes. */
export interface AppSession {
  /** Current user, or null. */
  readonly user: AuthUser | null;
  /** True when a session exists. */
  readonly isAuthenticated: boolean;
  /** True during the initial session check. */
  readonly isLoading: boolean;
  /** Current CSRF token. */
  readonly csrfToken: string | null;
  /** Redirects to the OIDC login endpoint with a return path. */
  readonly login: (returnTo?: string) => void;
  /** Revokes the server session and clears local state. */
  readonly logout: () => Promise<void>;
  /** Refreshes the session. */
  readonly refresh: () => Promise<boolean>;
}

const SessionContext = createContext<AppSession | null>(null);

/**
 * Bridges the BlendSDK auth provider into an application-owned context.
 *
 * The bridge keeps page code independent of the SDK's concrete shape and lets
 * component tests provide a session without mounting the provider.
 */
export function SessionBridge({ children }: { readonly children: ReactNode }) {
  const auth = useAuth();
  return (
    <SessionContext.Provider
      value={{
        user: auth.user,
        isAuthenticated: auth.isAuthenticated,
        isLoading: auth.isLoading,
        csrfToken: auth.csrfToken,
        login: auth.login,
        logout: auth.logout,
        refresh: auth.refresh,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

/** Returns the application session. Throws outside the bridge or a fixture. */
export function useSession(): AppSession {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error("useSession must be used inside SessionBridge");
  }
  return value;
}

/** Provides a session in component tests. */
export function SessionFixture({
  value,
  children,
}: {
  readonly value: AppSession;
  readonly children: ReactNode;
}) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
