import { describe, expect, test } from "vitest";
import type { AlibiBundle } from "../src/schema.ts";
import {
  type ChainReader,
  collapse,
  expand,
  pointers,
  UNBOUND,
  valueAt,
  verifyAlibi,
} from "../src/verify/index.ts";
import { fixtures } from "./fixtures.ts";
import { liveChain, memoized, mutate, setAt } from "./live.ts";

const live = process.env.KEELSON_LIVE === "1";

/**
 * Carried in dstack's TDX document and read by no check: the raw versioned attestation, the
 * dstack version and the name, type and payload of the boot events, whose digests alone replay
 * into RTMR0–2.
 */
function carriedUnread(b: AlibiBundle, p: string): boolean {
  const m = /^\/tee\/attestations\/(\d+)\/document\/(.+)$/.exec(p);
  if (!m) return false;
  const [, i, rest] = m as unknown as [string, string, string];
  if (rest === "attestation" || rest === "dstack_version") return true;
  const e = /^eventLog\/(\d+)\/(event|event_type|event_payload)$/.exec(rest);
  if (!e) return false;
  const doc = b.tee.attestations[Number(i)]?.document as { eventLog: { imr: number }[] };
  return (doc.eventLog[Number(e[1])]?.imr ?? 3) < 3;
}

describe.skipIf(!live)("every field of a real Alibi is bound", () => {
  const chain: ChainReader = memoized(liveChain());

  test("only the capture id is left unbound", () => {
    expect(UNBOUND).toEqual(["/paypal/capture_id"]);
  });

  test.each(fixtures.map((f) => [f.id, f] as const))(
    "%s: editing any field fails and names it",
    async (_, f) => {
      const original = await verifyAlibi(f.bundle, { chain });
      expect(original.checks.filter((c) => c.status === "fail")).toEqual([]);
      for (const p of UNBOUND) {
        if (valueAt(f.bundle, p) !== undefined) {
          expect(original.unbound).toContainEqual({ pointer: p, value: valueAt(f.bundle, p) });
        }
      }
      const e = expand(f.bundle);
      const all = pointers(e).filter((p) => !UNBOUND.includes(p));
      const open = all.filter((p) => carriedUnread(f.bundle, p));
      const gaps: string[] = [];
      const started = performance.now();
      for (const p of all) {
        if (open.includes(p)) continue;
        const edited = structuredClone(e);
        setAt(edited, p, mutate(valueAt(e, p)));
        const r = await verifyAlibi(collapse(edited), { chain, original: f.bundle });
        const named = r.checks.some(
          (c) => c.status === "fail" && c.blame?.some((x) => x === p || x.startsWith(`${p}/`)),
        );
        if (r.verdict !== "failed" || !named) gaps.push(`${p}: ${r.verdict}`);
      }
      console.log(
        `${f.id} (${f.mode}${f.anchored ? ", anchored" : ""}): ${all.length - open.length} pointers edited, ${open.length} carried unread, ${((performance.now() - started) / 1000).toFixed(1)} s`,
      );
      expect(gaps).toEqual([]);
    },
    1_800_000,
  );
});
