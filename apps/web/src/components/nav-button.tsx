import { Button } from "@fluentui/react-components";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";

/** A Fluent button that navigates with the client-side router. */
export function NavButton({
  to,
  children,
  appearance = "secondary",
}: {
  readonly to: string;
  readonly children: ReactNode;
  readonly appearance?: "secondary" | "primary" | "subtle";
}) {
  const navigate = useNavigate();
  return (
    <Button appearance={appearance} onClick={() => navigate(to)}>
      {children}
    </Button>
  );
}
