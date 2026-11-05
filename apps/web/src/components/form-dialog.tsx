import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from "@fluentui/react-components";
import type { FormEvent, ReactNode } from "react";

/** One accessible modal form with a title and action row. */
export function FormDialog({
  open,
  title,
  description,
  children,
  actions,
  onSubmit,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly actions: ReactNode;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(_event, data) => onOpenChange(data.open)} modalType="modal">
      <DialogSurface>
        <form onSubmit={onSubmit} noValidate>
          <DialogBody>
            <DialogTitle>{title}</DialogTitle>
            <DialogContent className="stack">
              {description === undefined ? null : <p className="muted">{description}</p>}
              {children}
            </DialogContent>
            <DialogActions>{actions}</DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
