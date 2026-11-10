import { CopyValue } from "@keelson/ui/components/copy-value";
import { DataItem, DataList } from "@keelson/ui/components/data-list";
import { LiabilityMark } from "@keelson/ui/components/liability";
import { Timeline, TimelineItem } from "@keelson/ui/components/timeline";
import { cn } from "@keelson/ui/lib/utils";
import { AMBER_LABEL, type AmberField, amberValue, type AmberCase as Case } from "../lib/amber";
import { VERIFY } from "../lib/config";

const FIELDS: AmberField[] = ["size", "color", "unit_price", "returns_free"];

function attestedOf(a: Case["attested"], field: AmberField): string {
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

/**
 * The operator's amber attestation of a purchase and, once `AmberContradictionCourt` convicted
 * it, which field the store's own notarized answer contradicted, when, and the proof. `compact`
 * drops the timeline for narrow widgets.
 */
export function AmberCase({
  amber,
  purchaseId,
  compact = false,
  className,
}: {
  amber: Case | null;
  purchaseId: string;
  compact?: boolean;
  className?: string;
}) {
  if (!amber) {
    return (
      <section aria-label="Amber attestation" className={cn("grid gap-1 text-sm", className)}>
        <h3 className="font-medium">Amber attestation</h3>
        <p className="text-muted-foreground">
          None on this coverage: the cart had several lines, or it was covered before attestations.
        </p>
      </section>
    );
  }
  const v = amber.conviction;
  const headingId = `amber-${purchaseId}`;
  return (
    <section aria-labelledby={headingId} className={cn("grid gap-4", className)}>
      <header className="grid gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 id={headingId} className="font-medium">
            What the operator attested
          </h3>
          {v ? (
            <span className="font-medium text-sm text-vermilion-deep dark:text-vermilion">
              Proven false on chain
            </span>
          ) : (
            <span className="text-muted-foreground text-sm">No contradiction proven</span>
          )}
        </div>
        <p className="text-muted-foreground text-sm">
          {v
            ? `The store's own answer for ${amber.attested.sku}, notarized by Keelson's TLSNotary leg, holds another ${AMBER_LABEL[v.field].toLowerCase()}. A zero-knowledge proof showed it without revealing the answer.`
            : `Signed into the coverage as one commitment, backed by the operator's bond. AmberContradictionCourt convicts a field the store's own notarized answer contradicts.`}
        </p>
      </header>

      <ul className="divide-y rounded-lg border bg-card px-4 text-sm">
        {FIELDS.map((field) => {
          const false_ = v?.field === field;
          return (
            <li
              key={field}
              data-contradicted={false_ || undefined}
              className="flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2"
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="text-muted-foreground">{AMBER_LABEL[field]}</span>
                <span className={cn("font-medium tabular-nums", false_ && "line-through")}>
                  {attestedOf(amber.attested, field)}
                </span>
              </span>
              {false_ ? (
                <span className="font-medium text-vermilion-deep text-xs dark:text-vermilion">
                  Contradicted by the store
                </span>
              ) : (
                <LiabilityMark kind="attested" />
              )}
            </li>
          );
        })}
      </ul>

      {v && !compact ? (
        <Timeline aria-label="How the attestation was convicted">
          <TimelineItem state="done" actor="Operator">
            signed the attestation into the coverage
          </TimelineItem>
          <TimelineItem
            state="done"
            actor="Keelson's TLSNotary leg"
            {...(v.captured_at ? { time: v.captured_at } : {})}
            proof={{ href: amber.attested.url, label: "Store page" }}
          >
            notarized the store's answer for {amber.attested.sku}
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
        {v ? (
          <>
            {compact ? (
              <DataItem label="Proven">
                <time dateTime={v.proven_at} className="tabular-nums">
                  {new Date(v.proven_at).toLocaleString("en-US", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
              </DataItem>
            ) : null}
            <DataItem label="WebFact">
              <CopyValue value={v.web_fact_digest} label="WebFact digest" short />
            </DataItem>
            {v.proof ? (
              <DataItem label="C2b proof">
                <span className="inline-flex items-center gap-2">
                  <span className="text-muted-foreground tabular-nums">
                    {(v.proof.bytes / 1024).toFixed(1)} KB
                  </span>
                  <CopyValue value={v.proof.hash} label="proof hash" short />
                </span>
              </DataItem>
            ) : null}
          </>
        ) : null}
        <DataItem label="Commitment">
          <CopyValue value={amber.commitment} label="amber commitment" short />
        </DataItem>
      </DataList>

      <nav aria-label="Check the attestation" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {v ? (
          <a
            className="underline underline-offset-4"
            href={v.explorer_url}
            target="_blank"
            rel="noopener"
          >
            Conviction transaction ↗<span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}
        <a
          className="underline underline-offset-4"
          href={`${VERIFY}/a/${purchaseId}`}
          target="_blank"
          rel="noopener"
        >
          {v ? "Re-verify the proof in your browser ↗" : "Check it in the verifier ↗"}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </nav>
    </section>
  );
}
