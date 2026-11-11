import type { ReactNode } from "react";
import { RiveSeal, type Seal, SplitK } from "./brand";

const TICKS =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='26' height='22'%3E%3Crect x='12.4' y='6.5' width='1.2' height='9' fill='%23F2F0EA' fill-opacity='.07'/%3E%3C/svg%3E\")";

/** Whole dollars large, cents raised and small, as a balance reads on a card. */
export function CardAmount({ value, currency }: { value: number; currency: string }) {
  const parts = new Intl.NumberFormat("en-US", { style: "currency", currency }).formatToParts(
    value,
  );
  const cents = parts.find((p) => p.type === "fraction")?.value;
  const whole = parts
    .filter((p) => p.type !== "fraction" && p.type !== "decimal")
    .map((p) => p.value)
    .join("");
  return (
    <span className="tnum inline-flex items-start font-semibold tracking-[-0.035em]">
      {whole}
      {cents ? (
        <span className="mt-[0.18em] ml-0.5 text-[0.45em] tracking-normal">.{cents}</span>
      ) : null}
    </span>
  );
}

/**
 * The mandate as an object you hold: what the agent may buy, the cap, where and until when. The
 * seal closes once Keelson has read it and it can be signed.
 */
export function MandateVisual({
  amount,
  currency,
  amountLabel,
  what,
  chips,
  until,
  state,
  seal,
  footer,
  className,
}: {
  amount: number | null;
  currency: string;
  amountLabel: string;
  what: string;
  chips: string[];
  until: string | null;
  state: string;
  seal: Seal;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative isolate flex aspect-[1.586/1] w-full flex-col overflow-hidden rounded-[22px] bg-graphite p-[6%] text-bone shadow-[0_30px_60px_-30px_rgb(23_24_27/0.55),0_2px_6px_-2px_rgb(23_24_27/0.3)] ${className ?? ""}`}
      style={{ backgroundImage: TICKS, containerType: "inline-size" }}
    >
      <div
        aria-hidden="true"
        className="-z-10 absolute inset-0 bg-[radial-gradient(120%_80%_at_100%_0%,rgb(255_75_31/0.16),transparent_55%)]"
      />
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <SplitK stem="#F2F0EA" className="size-[max(18px,5cqi)]" />
          <span className="font-mono text-[max(10px,2.6cqi)] text-bone/70 uppercase tracking-[0.16em]">
            Mandate
          </span>
        </span>
        <span className="rounded-full border border-bone/20 px-2.5 py-0.5 font-mono text-[max(10px,2.4cqi)] text-bone/80 uppercase tracking-[0.12em]">
          {state}
        </span>
      </div>

      <div className="mt-auto grid gap-[1.5cqi]">
        <span className="text-[max(12px,3.2cqi)] text-bone/60">{amountLabel}</span>
        <span className="text-[max(34px,11cqi)] leading-none">
          {amount === null ? (
            <span className="text-bone/30">$—</span>
          ) : (
            <CardAmount value={amount} currency={currency} />
          )}
        </span>
      </div>

      <div className="mt-[4cqi] flex items-end justify-between gap-4">
        <div className="grid min-w-0 gap-[2cqi]">
          <p className="truncate text-[max(13px,3.6cqi)] text-bone/90">
            {what || <span className="text-bone/40">What it may buy</span>}
          </p>
          <ul className="flex min-h-[max(22px,5.6cqi)] flex-wrap gap-1.5">
            {chips.map((c) => (
              <li
                key={c}
                className="rounded-md bg-bone/10 px-2 py-0.5 text-[max(11px,2.8cqi)] text-bone/85"
              >
                {c}
              </li>
            ))}
            {until ? (
              <li className="rounded-md bg-bone/10 px-2 py-0.5 text-[max(11px,2.8cqi)] text-bone/85">
                Until {until}
              </li>
            ) : null}
          </ul>
        </div>
        <RiveSeal seal={seal} className="size-[max(48px,14cqi)] shrink-0" />
      </div>
      {footer}
    </div>
  );
}
