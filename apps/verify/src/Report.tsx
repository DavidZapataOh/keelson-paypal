import type { Check, FieldRow, Report as VerifyReport } from "@keelson/alibi/verify";
import { amountAuthorityNote, CHECKS, evidenceOf, STATUS, STEPS } from "./labels.ts";

const TONE = {
  pass: "text-ok",
  fail: "text-vermilion-deep",
  warn: "text-warn",
  mute: "text-muted-foreground",
} as const;

const DOT = {
  pass: "bg-ok",
  fail: "bg-vermilion",
  warn: "bg-warn",
  mute: "bg-border",
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
            (c.id.startsWith("anchor.") ||
              c.id === "timestamps" ||
              c.id === "zk.c1" ||
              c.id === "zk.c3")),
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
  const evidence = evidenceOf(check);
  const reason =
    check.status === "undisclosed"
      ? "The mandate's user or the agent operator can share the full Alibi."
      : check.reason;
  return (
    <li className="grid grid-cols-[1rem_1fr_auto] items-start gap-x-3 py-2.5" data-check={check.id}>
      <span className={`mt-1.5 size-2 rounded-full ${DOT[s.tone]}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-[15px]">{meta.label}</p>
        {reason && <p className="mt-0.5 break-words text-sm text-muted-foreground">{reason}</p>}
        {check.detail?.signedOn && (
          <p className="mt-0.5 text-sm text-muted-foreground">
            Signed on {check.detail.signedOn}, in Keelson's approval
          </p>
        )}
        {check.detail?.alert && <p className="mt-0.5 text-sm text-warn">{check.detail.alert}</p>}
        {check.id === "paypal.amount_authority" && check.detail && (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {amountAuthorityNote(check.detail)}
          </p>
        )}
        {evidence.note && <p className="mt-0.5 text-sm text-muted-foreground">{evidence.note}</p>}
        {evidence.link && (
          <a
            className="mt-0.5 inline-block font-mono text-xs text-muted-foreground underline hover:text-graphite"
            href={evidence.link.href}
            target="_blank"
            rel="noopener"
            data-proof
          >
            {evidence.link.label}
          </a>
        )}
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
        <p className="font-mono text-xs text-muted-foreground">
          {meta.who} · {check.ms.toFixed(1)} ms
        </p>
      </div>
    </li>
  );
}

const COLOR = { green: "bg-ok", amber: "bg-warn", grey: "bg-border" } as const;

const shown = (v: unknown) => (v === undefined ? "—" : JSON.stringify(v));

/** The trace's policies: what each compared, whether it held and who answers for it. */
function Fields({ fields }: { fields: FieldRow[] }) {
  return (
    <div className="mt-8">
      <h3 className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Fields</h3>
      <table className="mt-1 w-full border-y border-border text-left text-sm">
        <thead className="font-mono text-xs text-muted-foreground">
          <tr>
            <th className="py-2 font-normal">Field</th>
            <th className="py-2 font-normal">Observed</th>
            <th className="py-2 font-normal">Bound</th>
            <th className="py-2 text-right font-normal">Who answers</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {fields.map((f) => (
            <tr key={f.id} data-field={f.id} data-color={f.color}>
              <td className="py-2">
                <span
                  className={`mr-2 inline-block size-2 rounded-full ${COLOR[f.color]}`}
                  aria-hidden="true"
                />
                {f.id}
                {!f.pass && <span className="ml-2 text-vermilion-deep">denied</span>}
              </td>
              <td className="break-all py-2 font-mono text-xs">{shown(f.observed)}</td>
              <td className="break-all py-2 font-mono text-xs">{shown(f.bound)}</td>
              <td className="py-2 text-right" data-answers>
                {f.answers}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
        className={`rounded-[14px] border border-border bg-bone-2 p-6 ${banner.tone === "fail" ? "border-vermilion" : ""}`}
        role="status"
        data-verdict={report?.verdict ?? "running"}
      >
        <h2 id="verdict" className={`text-2xl font-semibold tracking-tight ${TONE[banner.tone]}`}>
          {banner.title}
        </h2>
        <p className="mt-1 text-muted-foreground">{banner.text}</p>
        {report?.mode === "degraded" && (
          <p className="mt-3 inline-block rounded-md border border-warn px-2 py-0.5 text-sm text-warn">
            Degraded: TDX leg only
          </p>
        )}
        {report && (
          <p className="mt-3 font-mono text-xs text-muted-foreground">
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
              <h3 className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                {step} · {STEPS[step]}
              </h3>
              <ul className="mt-1 divide-y divide-border border-y border-border">
                {inStep.map((c) => (
                  <Row key={c.id} check={c} />
                ))}
              </ul>
            </li>
          );
        })}
      </ol>

      {report && report.fields.length > 0 && <Fields fields={report.fields} />}

      {report && report.unbound.length > 0 && (
        <div className="mt-8">
          <h3 className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            Unverified metadata (Keelson Cloud's word)
          </h3>
          <dl className="mt-1 divide-y divide-border border-y border-border">
            {report.unbound.map((u) => (
              <div key={u.pointer} className="flex justify-between gap-4 py-2.5 text-sm">
                <dt className="font-mono">{u.pointer}</dt>
                <dd className="break-all font-mono text-muted-foreground">{String(u.value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}
