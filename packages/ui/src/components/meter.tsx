import type * as React from "react";
import { cn } from "#lib/utils";

/**
 * How much of a cap is used, as a bar and in words. Past 90% it turns warn and says so; it never
 * turns vermilion, which is Keelson's act.
 */
function Meter({
  label,
  value,
  max,
  format = String,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  label: string;
  value: number;
  max: number;
  format?: (n: number) => string;
}) {
  const ratio = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
  const near = ratio >= 0.9;
  const text = `${format(value)} of ${format(max)}`;
  return (
    <div data-slot="meter" className={cn("grid gap-1.5", className)} {...props}>
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums">{text}</span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot be themed the same in every browser */}
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={text}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full origin-left rounded-full transition-transform duration-200",
            near ? "bg-warn" : "bg-foreground",
          )}
          style={{ transform: `scaleX(${ratio})` }}
        />
      </div>
      {near && <p className="text-xs text-warn">Near the cap</p>}
    </div>
  );
}

export { Meter };
