import type { ReactNode } from "react";

/** A system error: graphite with a Vermilion Deep border and "!", so it never reads as a block. */
export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-vermilion-deep bg-graphite px-4 py-3 text-bone"
    >
      <span aria-hidden="true" className="font-bold font-mono">
        !
      </span>
      <div className="grid gap-1 text-sm">
        <span className="font-mono text-xs uppercase tracking-[0.14em]">Error</span>
        <span>{children}</span>
      </div>
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.14em]">
      {children}
    </p>
  );
}
