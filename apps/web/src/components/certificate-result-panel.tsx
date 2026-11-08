import {
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
} from "@fluentui/react-components";

/** One non-fatal warning returned by a certificate write. */
export interface CertificateWriteWarning {
  /** Stable warning code. */
  readonly code: string;
  /** Safe operator-facing message. */
  readonly message: string;
}

/**
 * Success panel shared by the import and generate dialogs.
 *
 * The panel stays visible until the operator closes it so every server warning
 * is read before the dialog disappears.
 */
export function CertificateResultPanel({
  title,
  versionId,
  warnings,
  onClose,
  onOpen,
}: {
  readonly title: string;
  readonly versionId: string;
  readonly warnings: readonly CertificateWriteWarning[];
  readonly onClose: () => void;
  readonly onOpen: () => void;
}) {
  return (
    <DialogBody>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent className="stack">
        <p>
          Version <code>{versionId}</code> is ready.
        </p>
        {warnings.length === 0 ? null : (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Review these warnings</MessageBarTitle>
              <ul>
                {warnings.map((warning) => (
                  <li key={`${warning.code}-${warning.message}`}>{warning.message}</li>
                ))}
              </ul>
            </MessageBarBody>
          </MessageBar>
        )}
      </DialogContent>
      <DialogActions>
        <Button appearance="secondary" onClick={onClose}>
          Close
        </Button>
        <Button appearance="primary" onClick={onOpen}>
          Open certificate
        </Button>
      </DialogActions>
    </DialogBody>
  );
}
