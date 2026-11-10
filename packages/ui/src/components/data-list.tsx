import type * as React from "react";
import { cn } from "#lib/utils";

/**
 * Label and value pairs. `row` puts the value on the right (receipts, ledgers); `stacked` puts the
 * label over the value (detail rails).
 */
function DataList({
  layout = "row",
  className,
  ...props
}: React.ComponentProps<"dl"> & { layout?: "row" | "stacked" }) {
  return (
    <dl
      data-slot="data-list"
      data-layout={layout}
      className={cn(
        "group/data-list text-sm",
        layout === "row" ? "divide-y divide-border" : "grid gap-4",
        className,
      )}
      {...props}
    />
  );
}

function DataItem({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { label: React.ReactNode }) {
  return (
    <div
      data-slot="data-item"
      className={cn(
        "group-data-[layout=row]/data-list:flex group-data-[layout=row]/data-list:min-h-10 group-data-[layout=row]/data-list:items-center group-data-[layout=row]/data-list:justify-between group-data-[layout=row]/data-list:gap-4 group-data-[layout=row]/data-list:py-2",
        "group-data-[layout=stacked]/data-list:grid group-data-[layout=stacked]/data-list:gap-1",
        className,
      )}
      {...props}
    >
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 group-data-[layout=row]/data-list:text-right">{children}</dd>
    </div>
  );
}

export { DataItem, DataList };
