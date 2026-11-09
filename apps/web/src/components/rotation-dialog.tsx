import { Button, Field, Input } from "@fluentui/react-components";
import { useEffect, useState } from "react";
import { useSessionApi } from "../session/session-api-provider.js";
import { copyCredential } from "./credential-copy.js";
import { FormDialog } from "./form-dialog.js";
import { generateSecretValue } from "./generated-value.js";
import { RotationErrorAlert } from "./rotation-errors.js";
import type { RotationSecret } from "./rotation-types.js";

/** Parses one optional future ISO timestamp. */
function parseExpiry(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > Date.now()
    ? new Date(parsed).toISOString()
    : undefined;
}

/**
 * Rotates one secret with a manual or generated value.
 *
 * The generated value lives only in component state and is cleared whenever
 * the dialog opens or closes.
 *
 * @param props - Open state, project, secret, and callbacks.
 */
export function RotationDialog({
  open,
  project,
  secret,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly project: string;
  readonly secret: RotationSecret;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const { client } = useSessionApi();
  const [value, setValue] = useState("");
  const [generated, setGenerated] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  const [failure, setFailure] = useState<unknown>(undefined);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [expiryError, setExpiryError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setValue("");
      setGenerated(false);
      setExpiresAt("");
      setFailure(undefined);
      setFieldError(undefined);
      setExpiryError(undefined);
      setSubmitting(false);
    }
  }, [open]);

  const generate = (): void => {
    setValue(generateSecretValue());
    setGenerated(true);
    setFieldError(undefined);
  };

  const submit = async (): Promise<void> => {
    if (value.length === 0) {
      setFieldError("Enter a value or generate one.");
      return;
    }
    const expiry = parseExpiry(expiresAt);
    if (expiresAt.trim().length > 0 && expiry === undefined) {
      setExpiryError("Use a future ISO timestamp.");
      return;
    }
    setFailure(undefined);
    setSubmitting(true);
    try {
      await client.secrets.writeSecretValue({
        project,
        name: secret.name,
        value,
        ...(expiry === undefined ? {} : { expiresAt: expiry }),
      });
      setValue("");
      onSaved();
      onClose();
    } catch (error) {
      setFailure(error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormDialog
      open={open}
      title="Rotate secret"
      description="The new version becomes current. The previous version remains readable."
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      actions={
        <>
          <Button appearance="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button appearance="primary" type="submit" disabled={submitting}>
            Rotate secret
          </Button>
        </>
      }
    >
      {failure === undefined ? null : <RotationErrorAlert error={failure} />}
      <Field
        label="New value"
        required
        {...(fieldError === undefined ? {} : { validationMessage: fieldError })}
      >
        <Input
          aria-label="New value"
          value={value}
          type={generated ? "text" : "password"}
          onChange={(_event, data) => {
            setValue(data.value);
            setGenerated(false);
            setFieldError(undefined);
          }}
          autoFocus
        />
      </Field>
      <div className="row-actions">
        <Button appearance="secondary" type="button" onClick={generate}>
          Generate value
        </Button>
        {generated ? (
          <Button appearance="secondary" type="button" onClick={generate}>
            Regenerate
          </Button>
        ) : null}
        <Button
          appearance="secondary"
          type="button"
          onClick={() => void copyCredential(value)}
          disabled={value.length === 0}
        >
          Copy value
        </Button>
      </div>
      {generated ? (
        <p className="muted" role="status">
          Copy this value now. It will not be shown again.
        </p>
      ) : null}
      <Field
        label="Expires at (optional ISO)"
        hint="For example 2027-01-01T00:00:00.000Z"
        {...(expiryError === undefined ? {} : { validationMessage: expiryError })}
      >
        <Input
          aria-label="Expires at (optional ISO)"
          value={expiresAt}
          onChange={(_event, data) => {
            setExpiresAt(data.value);
            setExpiryError(undefined);
          }}
        />
      </Field>
      <p className="muted">
        The agent fetches the new version on its next refresh. Restart or reload the application to
        use it.
      </p>
    </FormDialog>
  );
}
