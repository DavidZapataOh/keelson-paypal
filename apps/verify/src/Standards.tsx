import {
  type AlibiBundleV2,
  type AlibiReceiptV2,
  type AnyAlibi,
  statementOf,
} from "@keelson/alibi";
import type { Check, CheckId, Report } from "@keelson/alibi/verify";
import { saveBytes } from "./save.ts";
import { verifier } from "./verifier.ts";

type Tone = "pass" | "fail" | "wait" | "mute";

const DOT: Record<Tone, string> = {
  pass: "bg-ok",
  fail: "bg-vermilion",
  wait: "bg-warn",
  mute: "bg-border",
};
const WORD: Record<Tone, string> = {
  pass: "Verified",
  fail: "Failed",
  wait: "Pending",
  mute: "Not in this file",
};
const TEXT: Record<Tone, string> = {
  pass: "text-ok",
  fail: "text-vermilion-deep",
  wait: "text-warn",
  mute: "text-muted-foreground",
};

const toneOf = (checks: Check[], ids: CheckId[]): Tone => {
  const found = checks.filter((c) => ids.includes(c.id));
  if (found.length === 0) return "wait";
  if (found.some((c) => c.status === "fail")) return "fail";
  if (found.some((c) => c.status === "pass")) return "pass";
  if (found.every((c) => c.status === "undisclosed" || c.status === "absent")) return "mute";
  return "wait";
};

const isV2 = (a: AnyAlibi): a is AlibiBundleV2 | AlibiReceiptV2 => "statement" in a;
const json = (v: unknown) => new TextEncoder().encode(`${JSON.stringify(v, null, 2)}\n`);

/**
 * The open standards a v2 Alibi is made of, each with the check that holds it and, where it is a
 * file of its own, a download a third party's tooling reads.
 */
export default function Standards({
  alibi,
  checks,
  report,
}: {
  alibi: AnyAlibi;
  checks: Check[];
  report: Report | undefined;
}) {
  if (!isV2(alibi)) return null;
  const id = alibi.alibi_id;
  const rows: {
    key: string;
    name: string;
    spec: string;
    tone: Tone;
    download?: { label: string; save: () => void | Promise<void> };
  }[] = [
    {
      key: "statement",
      name: "Signed statement",
      spec: "IETF SCITT · RFC 9943",
      tone: toneOf(checks, ["scitt.statement"]),
      download: {
        label: "Download statement",
        save: () => saveBytes(`${id}.cose`, statementOf(alibi), "application/scitt-statement+cose"),
      },
    },
    {
      key: "receipt",
      name: "Log receipt",
      spec: "COSE Receipts · RFC 9942",
      tone: toneOf(checks, ["scitt.receipt"]),
    },
    {
      key: "proof",
      name: "Witnessed proof",
      spec: "C2SP tlog-proof",
      tone: toneOf(checks, ["log.witnesses"]),
    },
    {
      key: "timestamps",
      name: "Timestamps",
      spec: "RFC 3161 · RFC 9921",
      tone: toneOf(checks, ["timestamps"]),
    },
    {
      key: "evidence",
      name: "TEE evidence",
      spec: "RATS CMW · RFC 9999",
      tone: toneOf(checks, ["rats.cmw"]),
      ...("attestation" in alibi
        ? {
            download: {
              label: "Download evidence",
              save: () =>
                saveBytes(`${id}.cmw.json`, json(alibi.attestation), "application/cmw+json"),
            },
          }
        : {}),
    },
    {
      key: "results",
      name: "Attestation results",
      spec: "RATS EAR",
      tone: toneOf(checks, ["tee.attestation.tdx", "tee.attestation.nitro"]),
      ...(report
        ? {
            download: {
              label: "Download results",
              save: async () => {
                const { earOf } = await verifier;
                saveBytes(
                  `${id}.ear.json`,
                  json(earOf(report, new Date())),
                  "application/eat-ucs+json",
                );
              },
            },
          }
        : {}),
    },
  ];
  return (
    <section aria-labelledby="standards">
      <h3
        id="standards"
        className="font-mono text-xs uppercase tracking-wider text-muted-foreground"
      >
        Open standards
      </h3>
      <ul className="mt-1 divide-y divide-border border-y border-border">
        {rows.map((r) => (
          <li
            key={r.key}
            className="grid grid-cols-[1rem_1fr_auto] items-center gap-x-3 gap-y-2 py-2.5 sm:grid-cols-[1rem_1fr_auto_auto]"
            data-standard={r.key}
            data-tone={r.tone}
          >
            <span className={`size-2 rounded-full ${DOT[r.tone]}`} aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-[15px]">{r.name}</p>
              <p className="font-mono text-xs text-muted-foreground">{r.spec}</p>
            </div>
            <p className={`text-right text-sm ${TEXT[r.tone]}`}>{WORD[r.tone]}</p>
            {r.download && (
              <button
                type="button"
                className="col-start-2 justify-self-start rounded-md border border-border px-2.5 py-1 text-sm hover:border-graphite focus-visible:outline-2 focus-visible:outline-offset-2 sm:col-start-4 sm:row-start-1"
                onClick={() => void r.download?.save()}
              >
                {r.download.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
