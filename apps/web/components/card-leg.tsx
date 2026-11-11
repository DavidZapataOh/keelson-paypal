"use client";

import { MCC_LABELS } from "@keelson/mandate/browser";
import { Check, CreditCard, X } from "lucide-react";
import { money, when } from "../lib/format";
import type { CardAuthorization, Chargeback, PurchaseCard } from "../lib/types";
import { CHARGEBACKS } from "./chargeback-sheet";

/** Why the enclaves declined a card authorization, by `CARD_BITS` bit, in words. */
const BITS: readonly [number, string][] = [
  [0, "the cart was not allowed"],
  [1, "the mandate does not pay by card"],
  [2, "the card's window had closed"],
  [3, "another currency than the cart's"],
  [4, "more than the countersigned total"],
  [5, "a kind of store the mandate does not allow"],
  [6, "a country the mandate does not allow"],
  [7, "a store the cart did not name"],
  [8, "a second charge on a single-use card"],
];

const REASONS: Readonly<Record<string, string>> = {
  "card-not-open": "the card was not open yet",
  "card-expired": "the card's window had closed",
  "leg-unavailable": "an enclave did not answer in time, so the charge was declined",
  unverified: "an enclave's answer did not verify, so the charge was declined",
  "not-2of2": "only one enclave countersigned the cart",
};

function why(a: CardAuthorization): string {
  const said = BITS.filter(([bit]) => (a.failedMask >> bit) & 1).map(([, s]) => s);
  if (said.length > 0) return said.join("; ");
  return (a.reason && REASONS[a.reason]) ?? "declined";
}

const store = (mcc: string) => MCC_LABELS[mcc] ?? `MCC ${mcc}`;

function Leg({ name, signed }: { name: string; signed: boolean }) {
  return (
    <span
      className={`inline-flex h-6 items-center gap-1 rounded-full border px-2 font-mono text-[11px] ${signed ? "" : "border-dashed text-muted-foreground"}`}
    >
      {signed ? <Check className="size-3" strokeWidth={3} aria-hidden="true" /> : null}
      {name}
      <span className="sr-only">{signed ? " answered" : " did not answer"}</span>
    </span>
  );
}

function Authorization({ a }: { a: CardAuthorization }) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 py-3">
      <span
        className={`mt-0.5 grid size-5 place-items-center rounded-[4px] ${a.approved ? "bg-ok text-bone" : "bg-vermilion text-graphite"}`}
      >
        {a.approved ? (
          <Check className="size-3.5" strokeWidth={3} aria-label="approved" />
        ) : (
          <X className="size-3.5" strokeWidth={3} aria-label="declined" />
        )}
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate font-medium">{a.merchantName}</span>
        <span className="text-muted-foreground text-sm">
          {store(a.mcc)} · {a.merchantCountry}
        </span>
        <span className={`text-sm ${a.approved ? "text-muted-foreground" : ""}`}>
          {a.approved ? "Both enclaves approved the charge" : `Declined: ${why(a)}`}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          <Leg name="TDX" signed={a.legs.tdx} />
          <Leg name="Nitro" signed={a.legs.nitro} />
          <span className="font-mono text-muted-foreground text-xs tnum">
            {a.latencyMs} ms · {when(a.at)}
          </span>
        </span>
      </span>
      <span
        className={`font-mono text-[15px] tnum ${a.approved ? "" : "text-muted-foreground line-through decoration-vermilion-deep"}`}
      >
        {money(a.amountMinor, a.currency)}
      </span>
    </li>
  );
}

function ChargebackLine({ c, currency }: { c: Chargeback; currency: string }) {
  const decided = c.recoveredMinor !== null;
  return (
    <li className="grid gap-0.5">
      <span className="font-medium">
        Chargeback of {money(c.amountMinor, currency)}: {CHARGEBACKS[c.reason].label.toLowerCase()}
      </span>
      <span className="text-muted-foreground">
        {CHARGEBACKS[c.reason].codes} · {c.status.replaceAll("_", " ").toLowerCase()}
        {decided ? ` · returned ${money(c.recoveredMinor ?? "0", currency)}` : ""}
        {c.evidenceUploaded ? " · Alibi attached as evidence" : ""}
      </span>
    </li>
  );
}

/**
 * The card leg of a card purchase: the single-use card Keelson issued after the ALLOW, the
 * limits the issuer enforces on it, and every charge the card network sent, with what each
 * enclave decided and how fast.
 */
export function CardLeg({ card, currency }: { card: PurchaseCard; currency: string }) {
  const limit = card.controls.spend_limit_minor;
  const kinds = (card.controls.mcc ?? []).map(store);
  const settled = card.settledMinor;
  return (
    <section aria-labelledby="card-leg" className="rounded-3xl border bg-card p-5 sm:p-6">
      <div className="flex items-center gap-4">
        <span className="grid h-12 w-[4.5rem] shrink-0 place-items-end rounded-xl bg-graphite p-2 text-bone">
          <span className="whitespace-nowrap font-mono text-[11px] tnum">•••• {card.lastFour}</span>
        </span>
        <div className="grid min-w-0 gap-0.5">
          <h2 id="card-leg" className="flex items-center gap-2 font-semibold text-lg">
            <CreditCard className="size-4" aria-hidden="true" />
            Paid with PayPal · Keelson single-use card
          </h2>
          <p className="text-muted-foreground text-sm">
            Funded by your PayPal hold, issued after the ALLOW · test mode
          </p>
        </div>
      </div>
      <p className="mt-4 text-sm">
        {limit ? `Capped at ${money(limit, currency)}` : "Capped at the countersigned total"}, one
        charge, {card.controls.countries?.join(", ") ?? "the mandate's country"} only, until{" "}
        {when(card.expiresAt)}.{" "}
        <span className="text-muted-foreground">
          {kinds.length > 0 ? `Stores: ${kinds.join(", ")}.` : null} The issuer enforces these
          limits too.
        </span>
      </p>
      {card.authorizations.length > 0 ? (
        <ul className="mt-2 grid divide-y" aria-label="Charges on this card">
          {card.authorizations.map((a) => (
            <Authorization key={a.id} a={a} />
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-muted-foreground text-sm" role="status">
          {card.state === "OPEN"
            ? "Waiting for the store to charge the card."
            : card.state === "PAUSED"
              ? "The card opens once the purchase is sealed and covered."
              : "The card was never charged."}
        </p>
      )}
      {settled ? (
        <p className="mt-3 border-t pt-3 text-sm">
          Settled {money(settled, currency)}{" "}
          <span className="text-muted-foreground">(reported by the issuer, not signed)</span>
        </p>
      ) : null}
      {(card.chargebacks ?? []).length > 0 ? (
        <ul className="mt-3 grid gap-2 border-t pt-3 text-sm" aria-label="Chargebacks">
          {card.chargebacks.map((c) => (
            <ChargebackLine key={c.id} c={c} currency={currency} />
          ))}
          <li className="text-muted-foreground">
            The agent's bond can still pay at most {money(card.bondClaimMinor, currency)} over this
            purchase.
          </li>
        </ul>
      ) : null}
    </section>
  );
}
