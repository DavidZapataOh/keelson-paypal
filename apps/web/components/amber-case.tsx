import { CopyValue } from "@keelson/ui/components/copy-value";
import { DataItem, DataList } from "@keelson/ui/components/data-list";
import { LiabilityMark } from "@keelson/ui/components/liability";
import { Timeline, TimelineItem } from "@keelson/ui/components/timeline";
import { cn } from "@keelson/ui/lib/utils";
import { ArrowUpRight } from "lucide-react";
import { AMBER_LABEL, type AmberField, amberValue, type AmberCase as Case } from "../lib/amber";
import { VERIFY } from "../lib/config";

const FIELDS: AmberField[] = ["size", "color", "unit_price", "returns_free"];

function attestedOf(a: NonNullable<Case["attested"]>, field: AmberField): string {
  return amberValue(
    field,
    {
      size: a.size,
      color: a.color,
      unit_price: a.unit_minor,
      returns_free: a.returns_free,
    }[field],
  );
}

function OutLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-foreground"
      href={href}
      target="_blank"
      rel="noopener"
    >
      {children}
      <ArrowUpRight className="size-3.5" aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/**
 * The operator's amber attestation of a purchase and, once `AmberContradictionCourt` convicted
 * it, which field the store's own notarized answer contradicted, when, and the proof. `compact`
 * drops the card and the timeline for narrow widgets.
 */
export function AmberCase({
  amber,
  purchaseId,
  compact = false,
  className,
}: {
  amber: Case;
  purchaseId: string;
  compact?: boolean;
  className?: string;
}) {
  const v = amber.conviction;
  const a = amber.attested;
  const headingId = `amber-${purchaseId}`;
  // A card of its own on a page; a section of the widget it sits in.
  const Heading = compact ? "h3" : "h2";
  return (
    <section
      aria-labelledby={headingId}
      data-amber={v ? "contradicted" : "attested"}
      className={cn(
        "grid gap-4",
        compact ? "border-t pt-4" : "rounded-3xl border bg-card p-5 sm:p-6",
        className,
      )}
    >
      <header className="grid gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <Heading
            id={headingId}
            className={cn("font-semibold tracking-tight", compact ? "text-base" : "text-lg")}
          >
            What the operator attested
          </Heading>
          <span
            role="status"
            className={cn(
              "flex items-center gap-1.5 text-sm",
              v ? "font-medium text-vermilion-deep dark:text-vermilion" : "text-muted-foreground",
            )}
          >
            <span
              aria-hidden="true"
              className={cn("size-2 rounded-full", v ? "bg-vermilion" : "bg-field-attested")}
            />
            {v ? "Proven false on chain" : "No contradiction proven"}
          </span>
        </div>
        <p className="max-w-prose text-muted-foreground text-sm">
          {v
            ? `The store's own answer for ${a?.sku ?? "the item"}, notarized by Keelson's TLSNotary leg, holds another ${AMBER_LABEL[v.field].toLowerCase()}. A zero-knowledge proof showed it without revealing the answer.`
            : "Signed into the coverage as one commitment and backed by the operator's bond. If the store's own notarized answer contradicts a field, anyone can prove it on chain."}
        </p>
      </header>

      {a ? (
        <ul className="grid gap-1 rounded-2xl bg-bone-2/70 p-1.5 text-sm">
          {FIELDS.map((field) => {
            const contradicted = v?.field === field;
            return (
              <li
                key={field}
                data-contradicted={contradicted || undefined}
                className={cn(
                  "flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl px-3 py-2",
                  contradicted && "bg-card shadow-[0_1px_3px_rgb(23_24_27/0.12)]",
                )}
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="w-24 shrink-0 text-muted-foreground">{AMBER_LABEL[field]}</span>
                  <span
                    className={cn(
                      "font-medium tabular-nums",
                      contradicted && "line-through decoration-vermilion decoration-2",
                    )}
                  >
                    {attestedOf(a, field)}
                  </span>
                </span>
                {contradicted ? (
                  <span className="font-medium text-vermilion-deep text-xs dark:text-vermilion">
                    The store says otherwise
                  </span>
                ) : (
                  <LiabilityMark kind="attested" />
                )}
              </li>
            );
          })}
        </ul>
      ) : v ? (
        <div className="grid min-h-10 gap-1 rounded-2xl bg-bone-2/70 px-4 py-2.5 text-sm sm:flex sm:items-center sm:justify-between sm:gap-4">
          <p className="flex items-baseline gap-2">
            <span className="text-muted-foreground">Proven false</span>
            <span className="font-medium">{AMBER_LABEL[v.field]}</span>
          </p>
          <p className="text-muted-foreground text-xs">
            Its value stays with the buyer, merchant and operator
          </p>
        </div>
      ) : null}

      {v && !compact ? (
        <Timeline aria-label="How the attestation was convicted">
          <TimelineItem state="done" actor="Operator">
            signed the attestation into the coverage
          </TimelineItem>
          <TimelineItem
            state="done"
            actor="Keelson's TLSNotary leg"
            {...(v.captured_at ? { time: v.captured_at } : {})}
            {...(a ? { proof: { href: a.url, label: "Store page" } } : {})}
          >
            notarized the store's answer for {a?.sku ?? "the item"}
          </TimelineItem>
          <TimelineItem
            state="blocked"
            actor="AmberContradictionCourt"
            time={v.proven_at}
            proof={{ href: v.explorer_url, label: "Arbiscan" }}
          >
            verified the C2b proof and convicted the {AMBER_LABEL[v.field].toLowerCase()}
          </TimelineItem>
        </Timeline>
      ) : null}

      <DataList layout="row">
        {v && compact ? (
          <DataItem label="Proven">
            <time dateTime={v.proven_at} className="tabular-nums">
              {new Date(v.proven_at).toLocaleString("en-US", {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </time>
          </DataItem>
        ) : null}
        {v ? (
          <DataItem label="WebFact">
            <CopyValue value={v.web_fact_digest} label="WebFact digest" short />
          </DataItem>
        ) : null}
        {v?.proof ? (
          <DataItem label="C2b proof">
            <span className="inline-flex items-center gap-2">
              <span className="text-muted-foreground tabular-nums">
                {(v.proof.bytes / 1024).toFixed(1)} KB
              </span>
              <CopyValue value={v.proof.hash} label="proof hash" short />
            </span>
          </DataItem>
        ) : null}
        <DataItem label="Commitment">
          <CopyValue value={amber.commitment} label="amber commitment" short />
        </DataItem>
      </DataList>

      <nav
        aria-label="Check the attestation"
        className="flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground text-sm"
      >
        {v ? <OutLink href={v.explorer_url}>Conviction transaction</OutLink> : null}
        <OutLink href={`${VERIFY}/a/${purchaseId}`}>
          {v ? "Re-verify the proof in your browser" : "Check it in the verifier"}
        </OutLink>
      </nav>
    </section>
  );
}
