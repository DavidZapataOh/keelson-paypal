import { Check, X } from "lucide-react";
import type { ReactNode } from "react";

export type MarkKind = "bought" | "blocked" | "checking" | "attention";

/** A row's 40 px mark: green check bought, vermilion X blocked, a dot while open. */
export function Mark({ kind }: { kind: MarkKind }) {
  const base = "grid size-10 shrink-0 place-items-center rounded-xl";
  if (kind === "blocked")
    return (
      <span className={`${base} bg-vermilion text-graphite`}>
        <X className="size-5" strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  if (kind === "bought")
    return (
      <span className={`${base} bg-ok text-bone`}>
        <Check className="size-5" strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  return (
    <span className={`${base} bg-bone-2`}>
      <span
        className={`size-2.5 rounded-full ${kind === "checking" ? "animate-pending bg-foreground" : "bg-warn"}`}
      />
    </span>
  );
}

export function Panel({
  title,
  aside,
  children,
  className,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={`rounded-3xl border bg-card p-5 sm:p-6 ${className ?? ""}`}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-lg tracking-tight">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A segmented control on bone-2: one choice out of a few, with an optional count each. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  counts,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  counts?: Partial<Record<T, number>>;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 rounded-xl bg-bone-2 p-1">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="tab"
          aria-selected={value === o}
          onClick={() => onChange(o)}
          className="h-8 whitespace-nowrap rounded-lg px-2.5 text-sm sm:px-3 aria-selected:bg-card aria-selected:font-medium aria-selected:shadow-[0_1px_3px_rgb(23_24_27/0.12)]"
        >
          {o}
          {counts?.[o] !== undefined ? (
            <span className="text-muted-foreground tnum"> {counts[o]}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
