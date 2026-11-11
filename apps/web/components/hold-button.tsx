"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";

/**
 * A consequential action that only fires once held for `ms`: by pointer, or by keeping Space or
 * Enter down. Letting go early cancels it.
 */
export function HoldButton({
  children,
  hint,
  onConfirm,
  ms = 1200,
  disabled,
  className,
}: {
  children: ReactNode;
  hint: string;
  onConfirm: () => void;
  ms?: number;
  disabled?: boolean;
  className?: string;
}) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hintId = useId();

  const start = () => {
    if (disabled || timer.current) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setHolding(false);
      onConfirm();
    }, ms);
  };
  const stop = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setHolding(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-describedby={hintId}
        onPointerDown={start}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) {
            e.preventDefault();
            start();
          }
        }}
        onKeyUp={(e) => (e.key === " " || e.key === "Enter") && stop()}
        onContextMenu={(e) => e.preventDefault()}
        className={`relative isolate overflow-hidden select-none touch-none ${className ?? ""}`}
      >
        <span
          aria-hidden="true"
          className="-z-10 absolute inset-0 origin-left bg-vermilion/25"
          style={{
            transform: `scaleX(${holding ? 1 : 0})`,
            transition: `transform ${holding ? ms : 150}ms ${holding ? "linear" : "ease-out"}`,
          }}
        />
        {children}
      </button>
      <span id={hintId} className="sr-only">
        {hint}
      </span>
    </>
  );
}
