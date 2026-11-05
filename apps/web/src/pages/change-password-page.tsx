import { FormTextField, Loading } from "@blendsdk/fluentui-react-components";
import { Button } from "@fluentui/react-components";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { ErrorAlert } from "../components/feedback.js";
import { useAsync } from "../hooks/use-async.js";
import { reloadTo } from "../session/reload.js";
import { useSessionApi } from "../session/session-api-provider.js";
import { useSession } from "../session/session-context.js";

interface ChangeValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

/** The forced password-change screen. */
export function ChangePasswordPage() {
  const auth = useSession();
  const { client } = useSessionApi();
  const navigate = useNavigate();
  const [failure, setFailure] = useState<unknown>(undefined);
  const form = useForm<ChangeValues>({
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });
  const me = useAsync(
    async (signal) => await client.session.getMe({ signal }),
    [client, auth.isAuthenticated],
    auth.isAuthenticated,
  );

  if (me.loading) {
    return (
      <div className="centered-page">
        <Loading label="Checking your session…" />
      </div>
    );
  }
  if (me.data?.mustChangePassword !== true) {
    return (
      <main className="centered-page">
        <section className="login-card" aria-labelledby="change-title">
          <h1 id="change-title">Password already changed</h1>
          <p className="muted">Your account no longer requires a password change.</p>
          <Button appearance="primary" onClick={() => navigate("/", { replace: true })}>
            Continue to projects
          </Button>
        </section>
      </main>
    );
  }

  const submit = form.handleSubmit(async (values) => {
    setFailure(undefined);
    if (values.newPassword.length < 12) {
      form.setError("newPassword", { message: "Use at least 12 characters" });
      return;
    }
    if (values.newPassword !== values.confirmPassword) {
      form.setError("confirmPassword", { message: "The passwords do not match" });
      return;
    }
    try {
      await client.session.changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      reloadTo("/");
    } catch (error) {
      setFailure(error);
    }
  });

  return (
    <main className="centered-page">
      <section className="login-card" aria-labelledby="change-title">
        <h1 id="change-title">Change your password</h1>
        <p className="muted">
          Your account is marked for a password change. Choose a new password of at least 12
          characters.
        </p>
        {failure === undefined ? null : <ErrorAlert error={failure} />}
        <form className="stack" onSubmit={(event) => void submit(event)} noValidate>
          <FormTextField
            control={form.control}
            name="currentPassword"
            label="Current password"
            type="password"
            autoComplete="current-password"
            required
          />
          <FormTextField
            control={form.control}
            name="newPassword"
            label="New password"
            type="password"
            autoComplete="new-password"
            hint="At least 12 characters"
            required
          />
          <FormTextField
            control={form.control}
            name="confirmPassword"
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            required
          />
          <Button type="submit" appearance="primary" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Changing…" : "Change password"}
          </Button>
        </form>
      </section>
    </main>
  );
}
