import { Button, Field, Input } from "@fluentui/react-components";
import { useEffect, useState } from "react";
import { useSessionApi } from "../session/session-api-provider.js";
import { ErrorAlert } from "./feedback.js";
import { FormDialog } from "./form-dialog.js";
import type { RotationSecret } from "./rotation-types.js";

/** Parses and validates one interval value. */
function parseInterval(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) {
    return undefined;
  }
  const days = Number(value);
  return Number.isSafeInteger(days) && days >= 1 && days <= 3_650 ? days : undefined;
}

/**
 * Sets or clears one secret's rotation interval.
 *
 * @param props - Open state, project, secret, and callbacks.
 */
export function RotationPolicyDialog({
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
  const [interval, setIntervalValue] = useState("");
  const [failure, setFailure] = useState<unknown>(undefined);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setIntervalValue(
        secret.rotationIntervalDays === null ? "" : String(secret.rotationIntervalDays),
      );
      setFailure(undefined);
      setFieldError(undefined);
      setSubmitting(false);
    }
  }, [open, secret.rotationIntervalDays]);

  const save = async (value: number | null): Promise<void> => {
    setFailure(undefined);
    setSubmitting(true);
    try {
      await client.secrets.updateSecretMetadata({
        project,
        name: secret.name,
        rotationIntervalDays: value,
      });
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
      title="Set rotation policy"
      description="The due date is derived from the current version's creation time."
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        const days = parseInterval(interval);
        if (days === undefined) {
          setFieldError("Use a whole number between 1 and 3650.");
          return;
        }
        void save(days);
      }}
      actions={
        <>
          <Button appearance="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button appearance="secondary" onClick={() => void save(null)} disabled={submitting}>
            Remove policy
          </Button>
          <Button appearance="primary" type="submit" disabled={submitting}>
            Save policy
          </Button>
        </>
      }
    >
      {failure === undefined ? null : <ErrorAlert error={failure} />}
      <Field
        label="Interval days"
        required
        {...(fieldError === undefined ? {} : { validationMessage: fieldError })}
      >
        <Input
          aria-label="Interval days"
          value={interval}
          inputMode="numeric"
          onChange={(_event, data) => {
            setIntervalValue(data.value);
            setFieldError(undefined);
          }}
          autoFocus
        />
      </Field>
    </FormDialog>
  );
}
