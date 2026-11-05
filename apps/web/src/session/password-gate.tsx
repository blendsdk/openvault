import { Loading } from "@blendsdk/fluentui-react-components";
import { Navigate, Outlet, useLocation } from "react-router";
import { useAsync } from "../hooks/use-async.js";
import { useSession } from "../session/session-context.js";
import { useSessionApi } from "./session-api-provider.js";

/**
 * Forces a flagged account through the password-change screen.
 *
 * The server blocks every other route while `must_change` is set, so the UI
 * must not let a deep link dead-end. `/me` stays allowed during the gate.
 */
export function PasswordGate() {
  const auth = useSession();
  const { client } = useSessionApi();
  const location = useLocation();
  const me = useAsync(
    async (signal) => await client.session.getMe({ signal }),
    [client, auth.isAuthenticated],
    auth.isAuthenticated,
  );

  if (!auth.isAuthenticated) {
    return <Outlet />;
  }
  if (me.loading) {
    return (
      <div className="page-loading" aria-busy="true">
        <Loading label="Checking your session…" />
      </div>
    );
  }
  if (me.data?.mustChangePassword === true && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }
  return <Outlet />;
}
