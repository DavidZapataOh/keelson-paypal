"use client";

import { type ReactNode, useEffect, useRef } from "react";

const WASM = "/rive/rive.wasm";

/** The Split K: the stem is the mandate, the chevron the countersign. */
export function SplitK({
  className,
  stem = "currentColor",
}: {
  className?: string;
  stem?: string;
}) {
  return (
    <svg viewBox="0 0 256 256" aria-hidden="true" className={className}>
      <path fill={stem} d="M22.87 16H82.6V240H22.87Z" />
      <path fill="#FF4B1F" d="M158.46 16H233.13L168.47 128L233.13 240H158.46L93.8 128Z" />
    </svg>
  );
}

export type Seal = "open" | "closing" | "closed";
export type Moment = "Seal" | "Passkey" | "Live" | "Blocked" | "Refund";

/**
 * One of the app's state moments (Rive, lite runtime, loaded on demand), played once when `play`
 * turns on. With reduced motion or without the runtime, `still` stands in.
 */
export function RiveMoment({
  artboard,
  play,
  still,
  className,
}: {
  artboard: Moment;
  play: boolean;
  still: ReactNode;
  className?: string | undefined;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!play || !el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let rive: { cleanup(): void } | undefined;
    let cancelled = false;
    import("@rive-app/canvas-lite")
      .then(({ Rive, RuntimeLoader, Layout, Fit }) => {
        if (cancelled) return;
        RuntimeLoader.setWasmUrl(WASM);
        rive = new Rive({
          src: "/rive/states.riv",
          canvas: el,
          artboard,
          stateMachines: "Play",
          autoplay: true,
          layout: new Layout({ fit: Fit.Contain }),
          onLoad: () => {
            el.dataset.ready = "true";
          },
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      el.dataset.ready = "false";
      rive?.cleanup();
    };
  }, [play, artboard]);

  return (
    <span className={`relative grid place-items-center ${className ?? ""}`}>
      <canvas
        ref={canvas}
        width={320}
        height={320}
        data-moment={artboard}
        className="peer absolute inset-0 size-full opacity-0 data-[ready=true]:opacity-100"
      />
      <span className="contents peer-data-[ready=true]:[&>*]:opacity-0">{still}</span>
    </span>
  );
}

/** The seal on the mandate card: faint while open, closing once Keelson has read it. */
export function RiveSeal({ seal, className }: { seal: Seal; className?: string }) {
  return (
    <RiveMoment
      artboard="Seal"
      play={seal === "closing"}
      className={className}
      still={
        <SplitK
          stem="#F2F0EA"
          className={`size-[46%] transition-opacity duration-200 ${seal === "open" ? "opacity-25" : ""}`}
        />
      }
    />
  );
}
