import type * as React from "react";
import { Status } from "#components/status";
import { cn } from "#lib/utils";

/**
 * Why Keelson blocked a cart, in one line and without alarm: what the mandate allows, what the
 * cart asked for, and the block.
 */
function BlockDiff({
  field,
  mandate,
  cart,
  className,
  ...props
}: React.ComponentProps<"p"> & { field: string; mandate: string; cart: string }) {
  return (
    <p
      data-slot="block-diff"
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-sm tabular-nums",
        className,
      )}
      {...props}
    >
      <span className="sr-only">{field}: </span>
      <span>
        <span className="text-muted-foreground">Mandate </span>
        {mandate}
      </span>
      <span aria-hidden="true" className="text-muted-foreground">
        ·
      </span>
      <span>
        <span className="text-muted-foreground">Cart </span>
        {cart}
      </span>
      <span aria-hidden="true" className="text-muted-foreground">
        ·
      </span>
      <Status state="blocked" className="font-sans" />
    </p>
  );
}

export { BlockDiff };
