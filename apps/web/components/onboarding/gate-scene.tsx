"use client";

import { Check, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { MandateVisual } from "../mandate-visual";

const CARTS = [
  { id: "a", store: "R", title: "Trail runner 2 · size 10", amount: "$89.00", ok: true },
  { id: "b", store: "R", title: "Bundle deal · 3 pairs", amount: "$340.00", ok: false },
] as const;

function Ticket({ cart }: { cart: (typeof CARTS)[number] }) {
  return (
    <div
      data-ticket={cart.id}
      className="absolute inset-x-0 top-0 flex items-center gap-3 rounded-2xl border bg-card px-4 py-3 opacity-0 shadow-[0_18px_40px_-24px_rgb(23_24_27/0.45)] data-[ok=false]:border-vermilion"
      data-ok={cart.ok}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-bone-2 font-semibold text-sm">
        {cart.store}
      </span>
      <span className="grid min-w-0 flex-1">
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
          Agent's cart
        </span>
        <span className="truncate text-sm">{cart.title}</span>
      </span>
      <span className="relative font-mono text-sm tnum">
        {cart.amount}
        {cart.ok ? null : (
          <span
            data-strike={cart.id}
            className="absolute top-1/2 left-0 h-px w-full origin-left scale-x-0 bg-vermilion-deep"
          />
        )}
      </span>
      <span
        data-scan={cart.id}
        className="pointer-events-none absolute inset-y-2 left-0 w-px bg-vermilion opacity-0"
      />
    </div>
  );
}

function Verdict({ cart }: { cart: (typeof CARTS)[number] }) {
  return (
    <li
      data-verdict={cart.id}
      className="flex items-center gap-3 rounded-2xl bg-card/90 px-4 py-3 opacity-0 shadow-[0_10px_30px_-22px_rgb(23_24_27/0.5)]"
    >
      <span
        className={`grid size-7 shrink-0 place-items-center rounded-md ${cart.ok ? "bg-ok text-bone" : "bg-vermilion text-graphite"}`}
      >
        {cart.ok ? (
          <Check className="size-4" strokeWidth={2.5} />
        ) : (
          <X className="size-4" strokeWidth={2.5} />
        )}
      </span>
      <span className="grid min-w-0 flex-1 leading-tight">
        <span className="font-medium text-sm">{cart.ok ? "Bought" : "Blocked"}</span>
        <span className="truncate text-muted-foreground text-xs">
          {cart.ok ? "Inside your rules · paid with PayPal" : "Over your $100 cap · nothing paid"}
        </span>
      </span>
      <span
        className={`font-mono text-sm tnum ${cart.ok ? "" : "text-muted-foreground line-through"}`}
      >
        {cart.amount}
      </span>
    </li>
  );
}

/**
 * An example of the gate at work: the agent brings carts to a mandate; the one inside it is paid,
 * the one outside it is stopped before PayPal moves any money.
 */
export function GateScene() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const q = (s: string) => el.querySelectorAll<HTMLElement>(s);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const v of q("[data-verdict]")) v.style.opacity = "1";
      return;
    }
    let tl: { kill(): void } | undefined;
    let cancelled = false;
    import("gsap")
      .then(({ gsap }) => {
        if (cancelled) return;
        const EASE = "expo.out";
        const t = gsap.timeline({ repeat: -1, repeatDelay: 0.6, delay: 0.3 });
        const card = el.querySelector("[data-card]");
        for (const [i, cart] of CARTS.entries()) {
          const at = i * 2.6;
          const ticket = `[data-ticket="${cart.id}"]`;
          t.fromTo(
            ticket,
            { y: -24, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.6, ease: EASE },
            at,
          )
            .fromTo(
              `[data-scan="${cart.id}"]`,
              { left: "0%", opacity: 1 },
              { left: "100%", duration: 0.7, ease: "power2.inOut" },
              at + 0.5,
            )
            .set(`[data-scan="${cart.id}"]`, { opacity: 0 }, at + 1.2)
            .fromTo(
              card,
              { scale: 1 },
              {
                scale: cart.ok ? 1.015 : 0.99,
                duration: 0.18,
                yoyo: true,
                repeat: 1,
                ease: "power2.out",
              },
              at + 1.2,
            );
          if (cart.ok) {
            t.to(
              ticket,
              { y: 70, scale: 0.92, opacity: 0, duration: 0.5, ease: "power2.in" },
              at + 1.5,
            );
          } else {
            t.to(
              `[data-strike="${cart.id}"]`,
              { scaleX: 1, duration: 0.25, ease: EASE },
              at + 1.25,
            ).to(ticket, { x: 16, opacity: 0, duration: 0.45, ease: "power2.in" }, at + 1.9);
          }
          t.fromTo(
            `[data-verdict="${cart.id}"]`,
            { y: -12, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.6, ease: EASE },
            at + (cart.ok ? 1.8 : 2.1),
          );
        }
        t.to("[data-verdict]", { opacity: 0, duration: 0.4 }, "+=2.2").set(`[data-strike]`, {
          scaleX: 0,
        });
        tl = t;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      tl?.kill();
    };
  }, []);

  return (
    <div ref={root} className="grid w-full max-w-[420px] gap-4">
      <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
        Example
      </span>
      <div className="relative h-[64px]">
        {CARTS.map((c) => (
          <Ticket key={c.id} cart={c} />
        ))}
      </div>
      <div data-card>
        <MandateVisual
          amount={100}
          currency="USD"
          amountLabel="Up to"
          what="Running shoes, size 10"
          chips={["RunFast"]}
          until="Fri"
          state="Active"
          seal="closed"
        />
      </div>
      <ul className="grid gap-2">
        {CARTS.map((c) => (
          <Verdict key={c.id} cart={c} />
        ))}
      </ul>
    </div>
  );
}
