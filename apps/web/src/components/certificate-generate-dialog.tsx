import { FormTextareaField, FormTextField } from "@blendsdk/fluentui-react-components";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Select,
} from "@fluentui/react-components";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { useSessionApi } from "../session/session-api-provider.js";
import {
  parseSans,
  parseSubject,
  parseTagLines,
  parseValidityDays,
  validateCertificateName,
} from "../validation.js";
import { CertificateErrorAlert } from "./certificate-errors.js";
import {
  CertificateResultPanel,
  type CertificateWriteWarning,
} from "./certificate-result-panel.js";

type KeyType = "ec-p256" | "rsa-2048" | "rsa-3072";

interface GenerateValues {
  name: string;
  subject: string;
  sans: string;
  keyType: KeyType;
  validityDays: string;
  tags: string;
}

interface WriteResult {
  readonly versionId: string;
  readonly warnings: readonly CertificateWriteWarning[];
  readonly name: string;
}

/** Generate a self-signed certificate or a new version of an existing one. */
export function CertificateGenerateDialog({
  open,
  project,
  renew,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly project: string;
  readonly renew?: { readonly name: string; readonly versionId: string } | undefined;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const { client } = useSessionApi();
  const navigate = useNavigate();
  const [result, setResult] = useState<WriteResult | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const form = useForm<GenerateValues>({
    defaultValues: {
      name: renew?.name ?? "",
      subject: "",
      sans: "",
      keyType: "ec-p256",
      validityDays: "365",
      tags: "",
    },
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    form.reset({
      name: renew?.name ?? "",
      subject: "",
      sans: "",
      keyType: "ec-p256",
      validityDays: "365",
      tags: "",
    });
    setResult(undefined);
    setFailure(undefined);
  }, [open, renew?.name, form]);

  const close = (): void => {
    setResult(undefined);
    setFailure(undefined);
    onClose();
  };

  const openCertificate = (): void => {
    const target = result?.name ?? form.getValues("name");
    close();
    navigate(
      `/projects/${encodeURIComponent(project)}/certificates/${encodeURIComponent(target)}?status=active`,
    );
  };

  const submit = form.handleSubmit(async (values) => {
    const nameMessage = validateCertificateName(values.name);
    if (nameMessage !== undefined) {
      form.setError("name", { message: nameMessage });
      return;
    }
    const subjectMessage = parseSubject(values.subject);
    if (subjectMessage !== undefined) {
      form.setError("subject", { message: subjectMessage });
      return;
    }
    const sans = parseSans(values.sans);
    if (sans.error !== undefined) {
      form.setError("sans", { message: sans.error });
      return;
    }
    const validity = parseValidityDays(values.validityDays);
    if (validity.error !== undefined) {
      form.setError("validityDays", { message: validity.error });
      return;
    }
    let tags: Record<string, string>;
    try {
      tags = parseTagLines(values.tags);
    } catch (error) {
      form.setError("tags", {
        message: error instanceof Error ? error.message : "Invalid tags",
      });
      return;
    }

    setFailure(undefined);
    try {
      const response = await client.certificates.generateCertificate({
        project,
        name: values.name,
        subject: values.subject,
        sans: sans.sans,
        keyType: values.keyType,
        validityDays: validity.days,
        tags,
        ...(renew === undefined ? {} : { expectedVersionId: renew.versionId }),
      });
      setResult({
        versionId: response.version.id,
        warnings: response.warnings,
        name: response.name,
      });
      onSaved();
    } catch (error) {
      setFailure(error);
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(_event, data) => {
        if (!data.open) {
          close();
        }
      }}
      modalType="modal"
    >
      <DialogSurface>
        {result === undefined ? (
          <form onSubmit={(event) => void submit(event)} noValidate>
            <DialogBody>
              <DialogTitle>
                {renew === undefined ? "Generate certificate" : "Generate new version"}
              </DialogTitle>
              <DialogContent className="stack">
                {failure === undefined ? null : <CertificateErrorAlert error={failure} />}
                <FormTextField
                  control={form.control}
                  name="name"
                  label="Certificate name"
                  hint="Letters, digits, and hyphens"
                  required
                  disabled={renew !== undefined}
                  autoFocus={renew === undefined}
                />
                <FormTextField
                  control={form.control}
                  name="subject"
                  label="Subject"
                  hint="RFC 4514 name such as CN=api.example.com"
                  required
                />
                <FormTextareaField
                  control={form.control}
                  name="sans"
                  label="SANs"
                  hint="One typed SAN per line: DNS:, IP:, URI:, or email:"
                  required
                />
                <Field label="Key type">
                  <Controller
                    control={form.control}
                    name="keyType"
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onChange={(event) => field.onChange(event.target.value as KeyType)}
                      >
                        <option value="ec-p256">EC P-256</option>
                        <option value="rsa-2048">RSA 2048</option>
                        <option value="rsa-3072">RSA 3072</option>
                      </Select>
                    )}
                  />
                </Field>
                <Field
                  label="Validity days"
                  hint="1–825 days"
                  validationState={
                    form.formState.errors.validityDays === undefined ? "none" : "error"
                  }
                  {...(form.formState.errors.validityDays === undefined
                    ? {}
                    : { validationMessage: form.formState.errors.validityDays.message })}
                >
                  <Controller
                    control={form.control}
                    name="validityDays"
                    render={({ field }) => (
                      <Input
                        type="number"
                        value={field.value}
                        onChange={(_event, data) => field.onChange(data.value)}
                      />
                    )}
                  />
                </Field>
                <FormTextareaField
                  control={form.control}
                  name="tags"
                  label="Tags"
                  hint="One key=value per line"
                />
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" appearance="primary" disabled={form.formState.isSubmitting}>
                  {renew === undefined ? "Generate certificate" : "Generate new version"}
                </Button>
              </DialogActions>
            </DialogBody>
          </form>
        ) : (
          <CertificateResultPanel
            title={renew === undefined ? "Certificate generated" : "New certificate version"}
            versionId={result.versionId}
            warnings={result.warnings}
            onClose={close}
            onOpen={openCertificate}
          />
        )}
      </DialogSurface>
    </Dialog>
  );
}
