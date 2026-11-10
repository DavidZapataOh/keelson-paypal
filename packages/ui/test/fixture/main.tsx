import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Badge } from "../../src/components/badge.tsx";
import { Button } from "../../src/components/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../src/components/card.tsx";
import { Liability, LiabilityMark } from "../../src/components/liability.tsx";
import { STATUS, Status } from "../../src/components/status.tsx";
import "./styles.css";

const fields = [
  { name: "Total ≤ $100.00", kind: "verified" },
  { name: "Merchant on the allowlist", kind: "verified" },
  { name: "Size 10", kind: "attested" },
  { name: "A color you will like", kind: "yours" },
] as const;

function Showcase() {
  return (
    <main className="mx-auto max-w-4xl space-y-10 px-6 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Proof before payment.</h1>
        <p className="text-muted-foreground">
          Every component of the Keelson design system, in its current theme.
        </p>
      </header>

      <section aria-labelledby="actions" className="space-y-3">
        <h2 id="actions" className="text-lg font-medium">
          Actions
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button>Sign the mandate</Button>
          <Button variant="secondary">Review fields</Button>
          <Button variant="outline">Open verifier</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="link">What Keelson does not do</Button>
          <Button disabled>Countersigning</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge>Sandbox</Badge>
          <Badge variant="secondary">Arbitrum Sepolia</Badge>
          <Badge variant="outline">PayPal sandbox</Badge>
        </div>
      </section>

      <section aria-labelledby="mandate">
        <Card>
          <CardHeader>
            <CardTitle id="mandate">Running shoes, up to $100</CardTitle>
            <CardDescription>
              Who answers for each field if the agent gets it wrong.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {fields.map((f) => (
                <li key={f.name} className="flex items-center justify-between gap-4 py-2.5">
                  <span>{f.name}</span>
                  <Liability kind={f.kind} />
                </li>
              ))}
            </ul>
          </CardContent>
          <CardFooter className="justify-between gap-4">
            <p className="font-mono text-sm tabular-nums">
              Mandate: max $100.00 · Cart: $340.00 ·{" "}
              <span className="text-destructive">Blocked</span>
            </p>
            <Status state="blocked" />
          </CardFooter>
        </Card>
      </section>

      <section aria-labelledby="matrix" className="space-y-3">
        <h2 id="matrix" className="text-lg font-medium">
          Field marks
        </h2>
        <div className="flex gap-4">
          <LiabilityMark kind="verified" />
          <LiabilityMark kind="attested" />
          <LiabilityMark kind="yours" />
        </div>
      </section>

      <section aria-labelledby="states" className="space-y-3">
        <h2 id="states" className="text-lg font-medium">
          Purchase states
        </h2>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(STATUS) as (keyof typeof STATUS)[]).map((s) => (
            <Status key={s} state={s} />
          ))}
        </div>
        <p className="font-mono text-sm text-muted-foreground">
          alibi 01M6W3TTKRC43V70XQAT1QQK6V · leaf 84712997ee424ff5
        </p>
      </section>
    </main>
  );
}

if (new URLSearchParams(location.search).get("theme") === "dark") {
  document.documentElement.classList.add("dark");
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Showcase />
  </StrictMode>,
);
