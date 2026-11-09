import type { Check, Report as VerifyReport } from "@keelson/alibi/verify";
import { CHECKS, STATUS, STEPS } from "./labels.ts";

const TONE = {
  pass: "text-pass",
  fail: "text-vermilion-deep",
  warn: "text-amber",
  mute: "text-ink-2",
} as const;

const DOT = {
  pass: "bg-pass",
  fail: "bg-vermilion",
  warn: "bg-amber",
  mute: "bg-line",
} as const;

interface Banner {
  tone: keyof typeof TONE;
  title: string;
  text: string;
}

/** The headline of a report: its verdict in words, and what to do about it. */
function bannerOf(report: VerifyReport | undefined, receipt: boolean): Banner {
  if (!report) return { tone: "mute", title: "Verifying…", text: "Checks appear as they finish." };
  const by = (s: Check["status"]) => report.checks.filter((c) => c.status === s);
  const failed = by("fail");
  const undisclosed = by("undisclosed").length;
  switch (report.verdict) {
    case "failed":
      return {
        tone: "fail",
        title: "Failed",
        text: failed
          .map((c) => `${CHECKS[c.id].label}: ${c.reason ?? "does not hold"}`)
          .slice(0, 3)
          .join(". "),
      };
    case "verified":
      return report.rpc?.custom
        ? {
            tone: "warn",
            title: "Verified with your RPC",
            text: "Every check passed; the anchor and the signer registry were read from the RPC you chose.",
          }
        : {
            tone: "pass",
            title: "Verified",
            text: "Every check passed against the pinned trust roots and the chain.",
          };
    case "verified-unanchored":
      return {
        tone: "warn",
        title: "Verified, not yet anchored",
        text: "Every check passed; the log checkpoint covering it is not anchored on-chain yet.",
      };
    case "verified-offline":
      return {
        tone: "warn",
        title: "Verified offline",
        text: "Every offline check passed; the anchor and the signer registry were not read.",
      };
    case "incomplete": {
      const unreachable = by("unreachable").length;
      const onlyUndisclosed = report.checks.every(
        (c) =>
          c.status === "pass" ||
          c.status === "undisclosed" ||
          c.status === "absent" ||
          (c.status === "pending" &&
            (c.id.startsWith("anchor.") || c.id === "timestamps" || c.id === "zk.c1")),
      );
      if (receipt && onlyUndisclosed) {
        const anchored = report.checks.some((c) => c.id === "anchor.root" && c.status === "pass");
        return {
          tone: anchored && !report.rpc?.custom ? "pass" : "warn",
          title: "Public receipt verified",
          text: `The log${anchored ? ", the anchor" : ""} and what the receipt carries hold${anchored ? "" : "; it is not anchored on-chain yet"}. ${undisclosed} checks need the full Alibi: drop its PDF or .alibi file.`,
        };
      }
      return {
        tone: "warn",
        title: "Incomplete",
        text: [
          unreachable ? `${unreachable} checks could not reach the chain.` : "",
          undisclosed ? `${undisclosed} checks were not disclosed to you.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      };
    }
  }
}

function Row({ check }: { check: Check }) {
  const s = STATUS[check.status];
  const meta = CHECKS[check.id];
  const reason =
    check.status === "undisclosed"
      ? "The mandate's user or the agent operator can share the full Alibi."
      : check.reason;
  return (
    <li className="grid grid-cols-[1rem_1fr_auto] items-start gap-x-3 py-2.5" data-check={check.id}>
      <span className={`mt-1.5 size-2 rounded-full ${DOT[s.tone]}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-[15px]">{meta.label}</p>
        {reason && <p className="mt-0.5 break-words text-sm text-ink-2">{reason}</p>}
        {check.blame && check.blame.length > 0 && (
          <p className="mt-1 font-mono text-xs text-vermilion-deep">
            Caused by {check.blame.join(", ")}
          </p>
        )}
      </div>
      <div className="text-right">
        <p className={`text-sm ${TONE[s.tone]}`} data-status={check.status}>
          {s.text}
        </p>
        <p className="font-mono text-xs text-ink-2">
          {meta.who} · {check.ms.toFixed(1)} ms
        </p>
      </div>
    </li>
  );
}

export function Report({
  checks,
  report,
  receipt,
}: {
  checks: Check[];
  report: VerifyReport | undefined;
  receipt: boolean;
}) {
  const banner = bannerOf(report, receipt);
  const steps = [...new Set(Object.keys(STEPS).map(Number))];
  return (
    <section aria-labelledby="verdict">
      <div
        className={`rounded-[14px] border border-line bg-bone-2 p-6 ${banner.tone === "fail" ? "border-vermilion" : ""}`}
        role="status"
        data-verdict={report?.verdict ?? "running"}
      >
        <h2 id="verdict" className={`text-2xl font-semibold tracking-tight ${TONE[banner.tone]}`}>
          {banner.title}
        </h2>
        <p className="mt-1 text-ink-2">{banner.text}</p>
        {report?.mode === "degraded" && (
          <p className="mt-3 inline-block rounded-md border border-amber px-2 py-0.5 text-sm text-amber">
            Degraded: TDX leg only
          </p>
        )}
        {report && (
          <p className="mt-3 font-mono text-xs text-ink-2">
            {report.checks.length} checks in {report.ms.toFixed(0)} ms
            {report.rpc &&
              ` · chain read from ${new URL(report.rpc.url).host}${report.rpc.custom ? " (your RPC)" : ""}`}
          </p>
        )}
      </div>

      <ol className="mt-6 space-y-6">
        {steps.map((step) => {
          const inStep = checks.filter((c) => c.step === step);
          if (!inStep.length) return null;
          return (
            <li key={step}>
              <h3 className="font-mono text-xs uppercase tracking-wider text-ink-2">
                {step} · {STEPS[step]}
              </h3>
              <ul className="mt-1 divide-y divide-line border-y border-line">
                {inStep.map((c) => (
                  <Row key={c.id} check={c} />
                ))}
              </ul>
            </li>
          );
        })}
      </ol>

      {report && report.unbound.length > 0 && (
        <div className="mt-8">
          <h3 className="font-mono text-xs uppercase tracking-wider text-ink-2">
            Unverified metadata (Keelson Cloud's word)
          </h3>
          <dl className="mt-1 divide-y divide-line border-y border-line">
            {report.unbound.map((u) => (
              <div key={u.pointer} className="flex justify-between gap-4 py-2.5 text-sm">
                <dt className="font-mono">{u.pointer}</dt>
                <dd className="break-all font-mono text-ink-2">{String(u.value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}
