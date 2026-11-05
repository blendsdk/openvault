import { FormTextField, Loading } from "@blendsdk/fluentui-react-components";
import { Button } from "@fluentui/react-components";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Navigate, useLocation } from "react-router";
import { ErrorAlert } from "../components/feedback.js";
import { useAsync } from "../hooks/use-async.js";
import { reloadTo } from "../session/reload.js";
import { useSessionApi } from "../session/session-api-provider.js";
import { useSession } from "../session/session-context.js";

interface LoginValues {
  identifier: string;
  password: string;
}

/** Returns a safe same-origin return path. */
function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  if (value.includes("\\") || /\p{Cc}/u.test(value)) {
    return "/";
  }
  return value;
}

/** Local and OIDC login. */
export function LoginPage() {
  const auth = useSession();
  const { client } = useSessionApi();
  const location = useLocation();
  const [failure, setFailure] = useState<unknown>(undefined);
  const form = useForm<LoginValues>({ defaultValues: { identifier: "", password: "" } });
  const meta = useAsync(
    async (signal) => await client.meta.getAuthCapabilities({ signal }),
    [client],
  );
  const returnTo = safeReturnTo((location.state as { returnTo?: unknown } | null)?.returnTo);

  if (auth.isLoading) {
    return (
      <div className="centered-page">
        <Loading label="Checking your session…" />
      </div>
    );
  }
  if (auth.isAuthenticated) {
    return <Navigate to={returnTo} replace />;
  }

  const submit = form.handleSubmit(async (values) => {
    setFailure(undefined);
    if (values.identifier.trim().length === 0) {
      form.setError("identifier", { message: "Enter your email or username" });
      return;
    }
    if (values.password.length === 0) {
      form.setError("password", { message: "Enter your password" });
      return;
    }
    try {
      const session = await client.session.loginLocal({
        identifier: values.identifier.trim(),
        password: values.password,
      });
      reloadTo(session.mustChangePassword ? "/change-password" : returnTo);
    } catch (error) {
      setFailure(error);
    }
  });

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand brand-large">
          <span className="brand-mark" aria-hidden="true">
            OV
          </span>
          <span className="brand-name">OpenVault</span>
        </div>
        <h1 id="login-title">Sign in</h1>
        <p className="muted">
          Use your OpenVault administrator account. The web UI never stores your password or session
          token in browser storage.
        </p>
        {failure === undefined ? null : <ErrorAlert error={failure} />}
        <form className="stack" onSubmit={(event) => void submit(event)} noValidate>
          <FormTextField
            control={form.control}
            name="identifier"
            label="Email or username"
            autoComplete="username"
            required
          />
          <FormTextField
            control={form.control}
            name="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            required
          />
          <Button type="submit" appearance="primary" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        {meta.data?.oidc === true ? (
          <>
            <div className="divider">or</div>
            <Button onClick={() => auth.login(returnTo)}>Continue with SSO</Button>
          </>
        ) : null}
        {meta.error === undefined ? null : (
          <p className="muted">
            Single sign-on availability could not be checked. Local sign-in still works.
          </p>
        )}
      </section>
    </main>
  );
}
