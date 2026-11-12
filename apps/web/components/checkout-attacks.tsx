import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@keelson/ui/components/table";
import { percent } from "../lib/scoreboard";
import board from "../public/redteam/checkout-attacks.json";

const CLASSES: Record<string, string> = {
  hidden: "Charges drawn outside the page's text",
  decoy: "Fake totals hidden from the buyer",
  fee: "Fees added on top of the total",
  total: "Another total on the page, cart or order",
  currency: "Currency signs, digits and locales",
  payee: "Look-alike payees",
  conversion: "Conversions over the spread",
  "tool-output": "Text posing as Keelson, the system or the user",
  offer: "Credit, installments and saved payment methods",
  button: "Pay buttons in the buyer's language",
};

/** The checkout-attack corpus against the pay-click gate, as the last CI run measured it. */
export function CheckoutAttacks() {
  const tiles = [
    {
      label: "Attacks through the gate",
      value: `${board.asr.k} of ${board.asr.n}`,
      detail: "pay clicks that reached a checkout charging something else",
      foot: `≤ ${percent(board.asr.hi_ppm, true)} at 95% · Clopper-Pearson`,
    },
    {
      label: "Honest checkouts held",
      value: `${board.false_blocks.k} of ${board.false_blocks.n}`,
      detail: "checkouts charging exactly what Keelson countersigned",
      foot: `≤ ${percent(board.false_blocks.hi_ppm, true)} at 95% · Clopper-Pearson`,
    },
  ];
  return (
    <section aria-labelledby="checkout-attacks" className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <h2 id="checkout-attacks" className="font-semibold text-xl tracking-[-0.01em]">
        Checkout attacks on the pay click
      </h2>
      <p className="max-w-prose text-pretty text-muted-foreground text-sm">
        Every change to the agent runs {board.attacks} attacks on the checkout page in a real
        browser: hidden totals, fees, look-alike payees, currency tricks and text posing as Keelson.
        The script clicks pay itself, so what holds an attack is the gate, never the model. Each
        night the same attacks run on a PayPal sandbox order from the demo store.{" "}
        <a href="/redteam/checkout-attacks.json" className="text-foreground underline">
          Download the scoreboard
        </a>
        .
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {tiles.map((t) => (
          <div key={t.label} className="grid content-start gap-2 rounded-lg border bg-card p-5">
            <p className="text-muted-foreground text-sm">{t.label}</p>
            <p className="font-semibold text-amount tabular-nums">{t.value}</p>
            <p className="text-pretty text-sm">{t.detail}</p>
            <p className="font-mono text-muted-foreground text-xs">{t.foot}</p>
          </div>
        ))}
      </div>
      <div className="rounded-lg border bg-card">
        <Table label="Checkout attacks by class">
          <caption className="sr-only">Attacks per class and how many got through</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Attack</TableHead>
              <TableHead scope="col" className="text-right">
                Attacks
              </TableHead>
              <TableHead scope="col" className="text-right">
                Through
              </TableHead>
              <TableHead scope="col" className="text-right">
                Upper bound
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {board.classes.map((c) => (
              <TableRow key={c.class}>
                <TableCell>{CLASSES[c.class] ?? c.class}</TableCell>
                <TableCell className="text-right tabular-nums">{c.attacks}</TableCell>
                <TableCell className="text-right tabular-nums">{c.through}</TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">
                  ≤ {percent(c.asr.hi_ppm, true)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
