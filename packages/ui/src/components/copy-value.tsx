"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import * as React from "react";
import { cn } from "#lib/utils";

/**
 * An identifier in mono with a copy button. `short` keeps the first six and last four characters
 * on screen; the full value is in the title and in what gets copied.
 */
function CopyValue({
  value,
  label,
  short = false,
  className,
  ...props
}: React.ComponentProps<"span"> & { value: string; label: string; short?: boolean }) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const shown = short && value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

  return (
    <span
      data-slot="copy-value"
      className={cn("inline-flex min-w-0 items-center gap-1 font-mono text-sm", className)}
      {...props}
    >
      <span className="truncate" title={short ? value : undefined}>
        {shown}
      </span>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={() => navigator.clipboard.writeText(value).then(() => setCopied(true))}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
      >
        {copied ? <CheckIcon className="size-3.5 text-ok" /> : <CopyIcon className="size-3.5" />}
      </button>
      <span role="status" className="sr-only">
        {copied ? `${label} copied` : ""}
      </span>
    </span>
  );
}

export { CopyValue };
