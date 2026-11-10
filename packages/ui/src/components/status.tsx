import type * as React from "react";
import { cn } from "#lib/utils";

/**
 * Tones of a purchase state. Vermilion fills only what Keelson did (`act`); a system error is
 * graphite with a Vermilion Deep border, so it never reads as a block.
 */
const TONES = {
  neutral: "border-border text-foreground",
  ok: "border-current text-ok",
  attention: "border-current text-warn",
  act: "border-transparent bg-vermilion text-graphite",
  error: "border-vermilion-deep bg-graphite text-bone",
} as const;

const STATUS = {
  "mandate-signed": { text: "Mandate signed", tone: "neutral" },
  checking: { text: "Checking", tone: "neutral" },
  countersigned: { text: "Countersigned", tone: "act" },
  blocked: { text: "Blocked", tone: "act" },
  authorized: { text: "Authorized", tone: "neutral" },
  captured: { text: "Captured", tone: "ok" },
  disputed: { text: "Disputed", tone: "attention" },
  resolved: { text: "Resolved", tone: "neutral" },
  refunded: { text: "Refunded", tone: "ok" },
  "bond-slashed": { text: "Bond slashed", tone: "attention" },
  error: { text: "Error", tone: "error" },
} as const satisfies Record<string, { text: string; tone: keyof typeof TONES }>;

type StatusState = keyof typeof STATUS;

function Glyph({ state }: { state: StatusState }) {
  const tone = STATUS[state].tone;
  if (tone === "error") {
    return (
      <span aria-hidden="true" className="font-mono font-bold">
        !
      </span>
    );
  }
  const paths: Record<Exclude<typeof tone, "error">, React.ReactNode> = {
    neutral: <circle cx="6" cy="6" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />,
    ok: (
      <path
        d="m2.5 6.25 2.25 2.25 4.75-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    attention: <path d="M6 1.5 10.5 10h-9Z" fill="currentColor" />,
    act:
      state === "blocked" ? (
        <rect x="2" y="2" width="8" height="8" fill="currentColor" />
      ) : (
        <path
          d="m3.5 2 4 4-4 4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      ),
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3 shrink-0">
      {paths[tone]}
    </svg>
  );
}

/** A purchase's state as a chip: text, glyph and tone together. */
function Status({
  state,
  className,
  ...props
}: React.ComponentProps<"span"> & { state: StatusState }) {
  const { text, tone } = STATUS[state];
  return (
    <span
      data-slot="status"
      data-state={state}
      data-tone={tone}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-sm border px-2 text-xs font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
      {...props}
    >
      <Glyph state={state} />
      <span>{text}</span>
    </span>
  );
}

export { STATUS, Status, type StatusState };
