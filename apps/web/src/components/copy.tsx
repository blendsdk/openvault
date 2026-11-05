import { Button } from "@fluentui/react-components";
import { Checkmark16Regular, Copy16Regular } from "@fluentui/react-icons";
import { useState } from "react";

/** Copies text and shows a short confirmation. */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  appearance = "secondary",
}: {
  readonly value: string;
  readonly label?: string;
  readonly copiedLabel?: string;
  readonly appearance?: "secondary" | "subtle" | "primary";
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <span className="copy-button">
      <Button
        size="small"
        appearance={appearance}
        icon={
          copied ? <Checkmark16Regular aria-hidden="true" /> : <Copy16Regular aria-hidden="true" />
        }
        onClick={() => {
          setFailed(false);
          if (navigator.clipboard === undefined) {
            setFailed(true);
            return;
          }
          void navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2_000);
            },
            () => setFailed(true),
          );
        }}
      >
        {copied ? copiedLabel : label}
      </Button>
      {failed ? (
        <span className="copy-failed" role="status">
          Clipboard unavailable
        </span>
      ) : null}
    </span>
  );
}

/** One line of CLI guidance with a copy affordance. */
export function CliHint({ command }: { readonly command: string }) {
  return (
    <div className="cli-hint">
      <code>{command}</code>
      <CopyButton value={command} label="Copy command" copiedLabel="Command copied" />
    </div>
  );
}
