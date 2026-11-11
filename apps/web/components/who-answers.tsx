import type { Card } from "@keelson/mandate/browser";
import { LiabilityMark } from "@keelson/ui/components/liability";

const ANSWERS = [
  { color: "green", kind: "verified", who: "Keelson checks" },
  { color: "amber", kind: "attested", who: "Agent's bond covers" },
  { color: "gray", kind: "yours", who: "Up to you" },
] as const;

/** Fields the card shows elsewhere, or that only matter to the operator. */
const QUIET = new Set(["mode", "recurrence", "currency", "agent", "bond", "summary", "budget"]);

/** The mandate's fields grouped by who answers for them if the agent gets one wrong. */
export function WhoAnswers({ card, className }: { card: Card; className?: string }) {
  return (
    <ul className={`grid gap-2 ${className ?? ""}`} aria-label="Who answers for each part">
      {ANSWERS.map(({ color, kind, who }, i) => {
        const fields = card.rows
          .filter((r) => r.color === color && !QUIET.has(r.field))
          .map((r) => r.label);
        if (fields.length === 0) return null;
        return (
          <li
            key={color}
            className="flex animate-reveal items-start gap-3 rounded-2xl bg-card px-4 py-3 shadow-[0_10px_30px_-24px_rgb(23_24_27/0.5)]"
            style={{ animationDelay: `${i * 90}ms`, animationFillMode: "both" }}
          >
            <LiabilityMark kind={kind} className="mt-0.5 size-5" />
            <span className="grid min-w-0 gap-0.5">
              <span className="font-medium text-sm">{who}</span>
              <span className="text-muted-foreground text-sm">{fields.join(" · ")}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
