import type * as React from "react";
import { cn } from "#lib/utils";

/**
 * Who answers for a mandate field if the agent gets it wrong. Always shown as color, shape and
 * label together, so it reads without color.
 */
const LIABILITY = {
  verified: { label: "Keelson-verified", shape: "square", color: "text-field-verified" },
  attested: { label: "Operator-attested · bonded", shape: "diamond", color: "text-field-attested" },
  yours: { label: "Yours · not covered", shape: "circle", color: "text-field-yours" },
} as const;

type LiabilityKind = keyof typeof LIABILITY;

function Shape({ kind }: { kind: LiabilityKind }) {
  switch (kind) {
    case "verified":
      return (
        <>
          <rect x="1" y="1" width="14" height="14" rx="2" fill="currentColor" />
          <path
            d="m4.5 8.25 2.25 2.25 4.75-5"
            fill="none"
            className="stroke-background"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case "attested":
      return (
        <path
          d="M8 1.25 14.75 8 8 14.75 1.25 8Z"
          fill="currentColor"
          fillOpacity="0.15"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      );
    case "yours":
      return (
        <circle
          cx="8"
          cy="8"
          r="6.25"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="2 2"
        />
      );
  }
}

/** The shape alone, for dense cells; named by its label for assistive technology. */
function LiabilityMark({
  kind,
  className,
  ...props
}: React.ComponentProps<"svg"> & { kind: LiabilityKind }) {
  const { label, shape, color } = LIABILITY[kind];
  return (
    <svg
      data-slot="liability-mark"
      data-shape={shape}
      role="img"
      aria-label={label}
      viewBox="0 0 16 16"
      className={cn("size-4 shrink-0", color, className)}
      {...props}
    >
      <Shape kind={kind} />
    </svg>
  );
}

/** The shape and its label. */
function Liability({
  kind,
  className,
  ...props
}: React.ComponentProps<"span"> & { kind: LiabilityKind }) {
  const { label, shape, color } = LIABILITY[kind];
  return (
    <span
      data-slot="liability"
      data-kind={kind}
      className={cn("inline-flex items-center gap-1.5 text-sm font-medium", color, className)}
      {...props}
    >
      <svg data-shape={shape} aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0">
        <Shape kind={kind} />
      </svg>
      {label}
    </span>
  );
}

/** A mandate field as a row: its name, its value and who answers for it. */
function LiabilityField({
  name,
  value,
  kind,
  className,
  ...props
}: React.ComponentProps<"div"> & { name: string; value?: React.ReactNode; kind: LiabilityKind }) {
  return (
    <div
      data-slot="liability-field"
      data-kind={kind}
      className={cn(
        "flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2",
        className,
      )}
      {...props}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="text-muted-foreground">{name}</span>
        {value !== undefined && <span className="font-medium">{value}</span>}
      </span>
      <Liability kind={kind} />
    </div>
  );
}

export { LIABILITY, Liability, LiabilityField, type LiabilityKind, LiabilityMark };
