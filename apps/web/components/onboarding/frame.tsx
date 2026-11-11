"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useSessionHint } from "../header";

export const STEPS = ["PayPal", "Rules", "Sign", "Agent"] as const;
export type Step = (typeof STEPS)[number];

function Progress({ current, complete }: { current: Step; complete: boolean }) {
  const at = complete ? STEPS.length : STEPS.indexOf(current);
  return (
    <ol
      aria-label={complete ? "All steps done" : `Step ${at + 1} of ${STEPS.length}`}
      className="flex items-center gap-1.5"
    >
      {STEPS.map((s, i) => (
        <li key={s} aria-current={i === at ? "step" : undefined} className="grid gap-1.5">
          <span
            className={`block h-1 w-10 rounded-full sm:w-16 ${i < at ? "bg-foreground" : i === at ? "bg-vermilion" : "bg-foreground/12"}`}
          />
          <span
            className={`hidden font-mono text-[11px] uppercase tracking-[0.12em] sm:block ${i === at ? "text-foreground" : "text-muted-foreground"}`}
          >
            {s}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * One onboarding step: the decision on the left, a living picture of it on the right. On a phone
 * the picture leads and the action sticks to the bottom of the screen.
 */
export function OnboardingFrame({
  step,
  stage,
  stageLabel,
  complete = false,
  children,
  action,
}: {
  step: Step;
  stage: ReactNode;
  /** Names the picture when it carries information; otherwise it is decoration. */
  stageLabel?: string | undefined;
  /** Every step is done: the bar fills. */
  complete?: boolean;
  children: ReactNode;
  action: ReactNode;
}) {
  useSessionHint();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 px-5 sm:h-20 sm:px-8">
        <Link href="/" className="shrink-0 rounded-sm" aria-label="Keelson, home">
          {/* biome-ignore lint/performance/noImgElement: a static export serves the SVG as is */}
          <img src="/keelson.svg" alt="" width={94} height={28} className="h-6 w-auto sm:h-7" />
        </Link>
        <Progress current={step} complete={complete} />
        <span className="hidden rounded-md border px-2 py-1 font-mono text-[11px] text-muted-foreground lg:block">
          PayPal sandbox
        </span>
      </header>

      <main
        id="main"
        className="mx-auto grid w-full max-w-[1280px] flex-1 gap-6 px-4 pb-4 sm:px-8 sm:pb-8 lg:grid-cols-[minmax(380px,460px)_1fr] lg:gap-12"
      >
        <section className="order-2 flex flex-col pb-28 lg:order-1 lg:justify-center lg:pb-0">
          {children}
          <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/92 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur-md lg:static lg:mt-8 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
            {action}
          </div>
        </section>
        <section
          aria-hidden={stageLabel ? undefined : true}
          aria-label={stageLabel}
          className="ticks relative order-1 grid min-h-[300px] place-items-center overflow-hidden rounded-[28px] bg-bone-2 px-5 py-8 sm:min-h-[420px] lg:order-2 lg:min-h-0"
        >
          {stage}
        </section>
      </main>
    </div>
  );
}
