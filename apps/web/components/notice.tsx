import { Alert, AlertDescription, AlertTitle } from "@keelson/ui/components/alert";
import type { ReactNode } from "react";

/** A system error: "!" and ERROR, never vermilion, so it never reads as a block. */
export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle className="font-mono text-xs uppercase tracking-[0.14em]">
        <span aria-hidden="true">! </span>Error
      </AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.14em]">
      {children}
    </p>
  );
}
