import { ArrowUpRightIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "#lib/utils";

/**
 * Steps of a purchase, each with who acted. `blocked` is Keelson's act and the only vermilion;
 * `failed` is a system failure, an ink "!" with a Vermilion Deep ring.
 */
type TimelineState = "done" | "current" | "upcoming" | "blocked" | "failed";

const MARKER: Record<TimelineState, string> = {
  done: "bg-foreground text-background",
  // The live step pulses while it waits (countersign, capture); nothing moves under reduced motion.
  current: "border-2 border-foreground bg-background motion-safe:animate-pending",
  upcoming: "border border-dashed border-muted-foreground bg-background",
  blocked: "rounded-[3px] bg-vermilion text-graphite",
  failed: "border border-vermilion-deep bg-graphite text-bone",
};

function Marker({ state }: { state: TimelineState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative z-10 flex size-4 shrink-0 items-center justify-center rounded-full",
        MARKER[state],
      )}
    >
      {state === "done" && (
        <svg aria-hidden="true" viewBox="0 0 12 12" className="size-2.5">
          <path
            d="m2.5 6.25 2.25 2.25 4.75-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {state === "current" && <span className="size-1.5 rounded-full bg-foreground" />}
      {state === "blocked" && <span className="size-1.5 bg-graphite" />}
      {state === "failed" && (
        <span className="font-mono text-[10px] leading-none font-bold">!</span>
      )}
    </span>
  );
}

function Timeline({ className, ...props }: React.ComponentProps<"ol">) {
  return <ol data-slot="timeline" className={cn("grid", className)} {...props} />;
}

/** One event: marker, actor, what they did, when, and where to check it. */
function TimelineItem({
  state,
  actor,
  time,
  timeLabel,
  proof,
  className,
  children,
  ...props
}: React.ComponentProps<"li"> & {
  state: TimelineState;
  actor: React.ReactNode;
  /** ISO 8601, for `<time dateTime>`. */
  time?: string;
  /** What to show for the time; defaults to `time` in UTC. */
  timeLabel?: React.ReactNode;
  /** Where this step can be checked outside the app: an explorer, the PayPal order, the log. */
  proof?: { href: string; label: string };
}) {
  return (
    <li
      data-slot="timeline-item"
      data-state={state}
      aria-current={state === "current" ? "step" : undefined}
      className={cn(
        "relative grid grid-cols-[1rem_1fr] gap-x-3 pb-5 last:pb-0",
        // The connector: solid for what happened, dotted for what has not.
        "before:absolute before:top-5 before:bottom-1 before:left-[calc(0.5rem-0.5px)] before:w-px last:before:hidden",
        state === "upcoming"
          ? "before:border-l before:border-dotted before:border-muted-foreground"
          : "before:bg-border",
        className,
      )}
      {...props}
    >
      <span className="pt-0.5">
        <Marker state={state} />
      </span>
      <div className="grid gap-0.5">
        <p
          className={cn(
            "text-sm",
            state === "upcoming" && "text-muted-foreground",
            state === "current" && "font-medium",
          )}
        >
          <span className="font-medium">{actor}</span> {children}
        </p>
        {(time || proof) && (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground tabular-nums">
            {time && (
              <time dateTime={time}>
                {timeLabel ?? `${time.replace("T", " ").replace(/\.\d+/, "").replace("Z", "")} UTC`}
              </time>
            )}
            {proof && (
              <a
                href={proof.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-current"
              >
                {proof.label}
                <ArrowUpRightIcon aria-hidden="true" className="size-3" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </span>
        )}
      </div>
    </li>
  );
}

export { Timeline, TimelineItem, type TimelineState };
