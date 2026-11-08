import { FormTextareaField } from "@blendsdk/fluentui-react-components";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Switch,
} from "@fluentui/react-components";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useSessionApi } from "../session/session-api-provider.js";
import { formatTagLines, parseTagLines } from "../validation.js";
import { CertificateErrorAlert } from "./certificate-errors.js";

interface MetadataValues {
  tags: string;
}

/**
 * Edit certificate tags and the one-way purge-protection flag.
 *
 * The server refuses to turn protection off once it is on, so the switch is
 * disabled and the dialog explains the rule. Submit stays disabled until a
 * value differs from the current certificate.
 */
export function CertificateMetadataDialog({
  open,
  project,
  certificate,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly project: string;
  readonly certificate: {
    readonly name: string;
    readonly tags: Readonly<Record<string, string>>;
    readonly purgeProtected: boolean;
  };
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const { client } = useSessionApi();
  const [purgeProtected, setPurgeProtected] = useState(certificate.purgeProtected);
  const [failure, setFailure] = useState<unknown>(undefined);
  const form = useForm<MetadataValues>({
    defaultValues: { tags: formatTagLines(certificate.tags) },
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    form.reset({ tags: formatTagLines(certificate.tags) });
    setPurgeProtected(certificate.purgeProtected);
    setFailure(undefined);
  }, [open, certificate.tags, certificate.purgeProtected, form]);

  const tagsText = form.watch("tags");
  const tagsChanged = tagsText !== formatTagLines(certificate.tags);
  const protectionChanged = purgeProtected !== certificate.purgeProtected;
  const changed = tagsChanged || protectionChanged;

  const submit = form.handleSubmit(async (values) => {
    let tags: Record<string, string>;
    try {
      tags = parseTagLines(values.tags);
    } catch (error) {
      form.setError("tags", {
        message: error instanceof Error ? error.message : "Invalid tags",
      });
      return;
    }
    if (!changed) {
      return;
    }
    setFailure(undefined);
    try {
      await client.certificates.updateCertificateMetadata({
        project,
        name: certificate.name,
        ...(tagsChanged ? { tags } : {}),
        ...(protectionChanged ? { purgeProtected } : {}),
      });
      onSaved();
      onClose();
    } catch (error) {
      setFailure(error);
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(_event, data) => {
        if (!data.open) {
          onClose();
        }
      }}
      modalType="modal"
    >
      <DialogSurface>
        <form onSubmit={(event) => void submit(event)} noValidate>
          <DialogBody>
            <DialogTitle>Edit certificate metadata</DialogTitle>
            <DialogContent className="stack">
              {failure === undefined ? null : <CertificateErrorAlert error={failure} />}
              <FormTextareaField
                control={form.control}
                name="tags"
                label="Tags"
                hint="One key=value per line; empty removes every tag"
              />
              <Switch
                label="Purge protection"
                checked={purgeProtected}
                disabled={certificate.purgeProtected}
                onChange={(_event, data) => setPurgeProtected(data.checked)}
              />
              {certificate.purgeProtected ? (
                <p className="muted">Purge protection cannot be turned off.</p>
              ) : null}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                appearance="primary"
                disabled={!changed || form.formState.isSubmitting}
              >
                Save metadata
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
