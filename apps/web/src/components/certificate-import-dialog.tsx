import { FormTextareaField, FormTextField } from "@blendsdk/fluentui-react-components";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from "@fluentui/react-components";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { useSessionApi } from "../session/session-api-provider.js";
import { parseTagLines, validateCertificateName } from "../validation.js";
import { CertificateErrorAlert } from "./certificate-errors.js";
import {
  CertificateResultPanel,
  type CertificateWriteWarning,
} from "./certificate-result-panel.js";
import { readPemFile } from "./pem.js";

const LEAF_MAX_BYTES = 262_144;
const CHAIN_MAX_BYTES = 262_144;
const KEY_MAX_BYTES = 65_536;

interface ImportValues {
  name: string;
  certificatePem: string;
  chainPem: string;
  privateKeyPem: string;
  tags: string;
  allowNotYetValid: boolean;
}

interface WriteResult {
  readonly versionId: string;
  readonly warnings: readonly CertificateWriteWarning[];
  readonly name: string;
}

/** Counts PEM blocks with one exact label. */
function countBlocks(value: string, label: string): number {
  return (value.match(new RegExp(`-----BEGIN ${label}-----`, "g")) ?? []).length;
}

/** Converts text to its UTF-8 byte length. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Validates one PEM field against its block and size limits. */
function validatePem(
  value: string,
  label: "CERTIFICATE" | "PRIVATE KEY",
  expectedBlocks: number,
  maxBytes: number,
): string | undefined {
  const blocks = countBlocks(value, label);
  if (expectedBlocks === 1 && value.trim().length === 0) {
    return `Paste the ${label.toLowerCase()}`;
  }
  if (expectedBlocks > 0 && blocks !== expectedBlocks) {
    return `Use exactly ${expectedBlocks} ${label} block`;
  }
  if (expectedBlocks === 0 && value.trim().length > 0 && blocks === 0) {
    return `Use at least one ${label} block or leave the field empty`;
  }
  if (byteLength(value) > maxBytes) {
    return `Use at most ${Math.round(maxBytes / 1_024)} KiB`;
  }
  if (value.includes("\u0000")) {
    return "Control characters are not allowed";
  }
  return undefined;
}

/** One hidden file input with a visible choose button. */
function PemFileButton({
  label,
  maxBytes,
  onText,
  onError,
}: {
  readonly label: string;
  readonly maxBytes: number;
  readonly onText: (text: string) => void;
  readonly onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="row-actions">
      <Button type="button" appearance="subtle" onClick={() => input.current?.click()}>
        Choose {label} file
      </Button>
      <input
        ref={input}
        type="file"
        accept=".pem,.key,.crt,.cer,text/plain"
        aria-label={`${label} file`}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file === undefined) {
            return;
          }
          void readPemFile(file, maxBytes)
            .then((text) => onText(text))
            .catch((error: unknown) => {
              onError(error instanceof Error ? error.message : "The file could not be read");
            })
            .finally(() => {
              event.target.value = "";
            });
        }}
      />
    </div>
  );
}

/**
 * Import a certificate and private key, or add a new version to an existing
 * certificate during renewal.
 */
export function CertificateImportDialog({
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
  const form = useForm<ImportValues>({
    defaultValues: {
      name: renew?.name ?? "",
      certificatePem: "",
      chainPem: "",
      privateKeyPem: "",
      tags: "",
      allowNotYetValid: false,
    },
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    form.reset({
      name: renew?.name ?? "",
      certificatePem: "",
      chainPem: "",
      privateKeyPem: "",
      tags: "",
      allowNotYetValid: false,
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
    const leafMessage = validatePem(values.certificatePem, "CERTIFICATE", 1, LEAF_MAX_BYTES);
    if (leafMessage !== undefined) {
      form.setError("certificatePem", { message: leafMessage });
      return;
    }
    const chainMessage = validatePem(values.chainPem, "CERTIFICATE", 0, CHAIN_MAX_BYTES);
    if (chainMessage !== undefined) {
      form.setError("chainPem", { message: chainMessage });
      return;
    }
    const keyMessage = validatePem(values.privateKeyPem, "PRIVATE KEY", 1, KEY_MAX_BYTES);
    if (keyMessage !== undefined) {
      form.setError("privateKeyPem", { message: keyMessage });
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
      const response = await client.certificates.importCertificate({
        project,
        name: values.name,
        certificatePem: values.certificatePem,
        ...(values.chainPem.length === 0 ? {} : { chainPem: values.chainPem }),
        privateKeyPem: values.privateKeyPem,
        tags,
        allowNotYetValid: values.allowNotYetValid,
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
                {renew === undefined ? "Import certificate" : "Import new version"}
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
                <FormTextareaField
                  control={form.control}
                  name="certificatePem"
                  label="Leaf certificate PEM"
                  hint="Exactly one CERTIFICATE block"
                  required
                />
                <PemFileButton
                  label="Leaf certificate"
                  maxBytes={LEAF_MAX_BYTES}
                  onText={(text) =>
                    form.setValue("certificatePem", text, { shouldValidate: false })
                  }
                  onError={(message) => form.setError("certificatePem", { message })}
                />
                <FormTextareaField
                  control={form.control}
                  name="chainPem"
                  label="Chain PEM"
                  hint="Zero or more CERTIFICATE blocks; optional"
                />
                <PemFileButton
                  label="Chain"
                  maxBytes={CHAIN_MAX_BYTES}
                  onText={(text) => form.setValue("chainPem", text, { shouldValidate: false })}
                  onError={(message) => form.setError("chainPem", { message })}
                />
                <FormTextareaField
                  control={form.control}
                  name="privateKeyPem"
                  label="Private key PEM"
                  hint="Exactly one PRIVATE KEY block"
                  required
                />
                <PemFileButton
                  label="Private key"
                  maxBytes={KEY_MAX_BYTES}
                  onText={(text) => form.setValue("privateKeyPem", text, { shouldValidate: false })}
                  onError={(message) => form.setError("privateKeyPem", { message })}
                />
                <FormTextareaField
                  control={form.control}
                  name="tags"
                  label="Tags"
                  hint="One key=value per line"
                />
                <Checkbox
                  label="Allow a certificate that is not yet valid"
                  checked={form.watch("allowNotYetValid")}
                  onChange={(_event, data) => {
                    form.setValue("allowNotYetValid", data.checked === true);
                  }}
                />
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" appearance="primary" disabled={form.formState.isSubmitting}>
                  {renew === undefined ? "Import certificate" : "Import new version"}
                </Button>
              </DialogActions>
            </DialogBody>
          </form>
        ) : (
          <CertificateResultPanel
            title={renew === undefined ? "Certificate imported" : "New certificate version"}
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
