"use client";

import { useEffect, useRef, useState } from "react";

const SCENES = [
  {
    artboard: "Sign",
    title: "You sign what the agent may buy.",
    body: "Write it in plain words: what, how much, where, by when. You sign it once with a passkey.",
  },
  {
    artboard: "Check",
    title: "Every cart is checked before it pays.",
    body: "A cart inside your mandate is countersigned. A cart outside it is blocked before PayPal moves any money.",
  },
  {
    artboard: "Answer",
    title: "Someone answers, and it isn't you.",
    body: "Each field says who pays if the agent gets it wrong: Keelson, the agent's bond, or you, and we say which before you sign.",
  },
] as const;

const SRC = "/rive/onboarding.riv";
const WASM = "/rive/rive.wasm";

/**
 * The three-step story of a mandate. Each step plays its Rive artboard; with reduced motion, or
 * if the runtime cannot load, the words stand on their own.
 */
export function Story() {
  const [step, setStep] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = SCENES[step] ?? SCENES[0];

  useEffect(() => {
    const el = canvas.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let rive: { cleanup(): void } | undefined;
    let cancelled = false;
    void import("@rive-app/canvas-lite")
      .then(({ Rive, RuntimeLoader, Layout, Fit }) => {
        if (cancelled) return;
        RuntimeLoader.setWasmUrl(WASM);
        rive = new Rive({
          src: SRC,
          canvas: el,
          artboard: scene.artboard,
          stateMachines: "Loop",
          autoplay: true,
          layout: new Layout({ fit: Fit.Contain }),
          onLoad: () => (el.dataset.ready = "true"),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      el.dataset.ready = "false";
      rive?.cleanup();
    };
  }, [scene.artboard]);

  return (
    <section aria-labelledby="story-title" className="grid gap-6">
      <div
        aria-hidden="true"
        className="relative aspect-[32/22] w-full overflow-hidden rounded-xl border bg-bone-2/60 dark:bg-graphite-2"
      >
        <canvas
          ref={canvas}
          width={640}
          height={440}
          className="size-full opacity-0 transition-opacity duration-200 data-[ready=true]:opacity-100"
        />
      </div>
      <div className="grid gap-2" aria-live="polite">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.14em]">
          Step {step + 1} of {SCENES.length}
        </p>
        <h2 id="story-title" className="text-balance font-semibold text-2xl tracking-tight">
          {scene.title}
        </h2>
        <p className="text-pretty text-muted-foreground">{scene.body}</p>
      </div>
      <nav className="flex items-center gap-2" aria-label="Story steps">
        {SCENES.map((s, i) => (
          <button
            key={s.artboard}
            type="button"
            aria-label={`Step ${i + 1}: ${s.title}`}
            aria-current={i === step ? "step" : undefined}
            onClick={() => setStep(i)}
            className="grid h-11 w-11 place-items-center rounded-md focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span
              className={`block h-1.5 rounded-full transition-all duration-200 ${i === step ? "w-8 bg-foreground" : "w-4 bg-border"}`}
            />
          </button>
        ))}
        {step < SCENES.length - 1 ? (
          <button
            type="button"
            onClick={() => setStep(step + 1)}
            className="ml-auto h-11 rounded-md px-3 font-medium text-sm underline-offset-4 hover:underline"
          >
            Next
          </button>
        ) : null}
      </nav>
    </section>
  );
}
