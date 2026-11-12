import { type Json, jcs } from "@keelson/core";
import { parseStatementLeaf } from "@keelson/log";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";
import { fromBase64, toBase64 } from "../src/b64.ts";
import { bridgeBundle } from "../src/bridge.ts";
import { encodeAny, receiptOf, registeredOf } from "../src/codec.ts";
import { alibiSchemaV2 } from "../src/schema.ts";
import type { ChainAnswer } from "../src/verify/chain.ts";
import { runCheck } from "../src/verify/check.ts";
import { registry } from "../src/verify/checks/chain.ts";
import { measurementHex } from "../src/verify/checks/util.ts";
import { type Check, verifyAlibi } from "../src/verify/index.ts";
import { legacyOf, statementView } from "../src/verify/view.ts";
import { fixtures } from "./fixtures.ts";
import { receiptFor, receiptKeys, vector } from "./v2.ts";

const now = new Date("2026-11-10T00:00:00Z");
const statusOf = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.id, c.status]));
const NAMES = { "2of2": "bridge-2of2", degraded: "bridge-degraded" } as const;

function bridged(f: (typeof fixtures)[number]) {
  const v = vector(NAMES[f.mode]);
  const statement = hexToBytes(v.statement_hex);
  return bridgeBundle(f.bundle, statement, [receiptFor(statement).receipt], f.bundle.tlog_proof);
}

/** The checks over what the v1 Alibi itself holds: neither the log nor the clock's. */
const PREIMAGE = [
  "leaf.view",
  "mandate.challenge",
  "mandate.passkey",
  "mandate.credentials",
  "tee.attestation.tdx",
  "tee.attestation.nitro",
  "tee.countersign",
  "policy.replay",
  "evidence.manifest",
  "paypal.ids",
  "card.authorizations",
  "zk.c1",
  "zk.c3",
  "evidence.web_fact",
  "evidence.checkout",
  "evidence.conversion",
];

describe.each(fixtures)("bridging the $mode fixture", (f) => {
  test("is a v2 bundle whose facts are byte-equal to the v1 countersign", () => {
    const b = bridged(f);
    expect(alibiSchemaV2.safeParse(b).success).toBe(true);
    expect(fromBase64(b.predecessor as string)).toEqual(fromBase64(f.bundle.leaf));
    const p = parseStatementLeaf(registeredOf(b));
    expect(p.kind).toBe("bridge");
    if (p.kind !== "bridge") return;
    const facts = Object.fromEntries(
      Object.entries(p.claims.countersign).map(([k, v]) => [k, String(v)]),
    );
    expect(jcs(facts as Json)).toBe(jcs(f.bundle.tee.countersign as unknown as Json));
    expect(p.claims.mode).toBe(f.mode);
    expect(encodeAny(b).length).toBeGreaterThan(0);
  });

  test("passes the statement and every preimage check exactly as the v1 bundle does", async () => {
    const [v1, v2] = await Promise.all([
      verifyAlibi(f.bundle, { now, receiptKeys }),
      verifyAlibi(bridged(f), { now, receiptKeys }),
    ]);
    const before = statusOf(v1.checks);
    const after = statusOf(v2.checks);
    for (const id of PREIMAGE) expect([id, after[id]]).toEqual([id, before[id]]);
    expect(after["scitt.statement"]).toBe("pass");
    expect(after["rats.cmw"]).toBe("pass");
    expect(after["card.statements"]).toBe("absent");
    expect(v2.mode).toBe(f.mode);
    const s = v2.checks.find((c) => c.id === "scitt.statement");
    expect(s?.detail?.bridged).toBe(vector(NAMES[f.mode]).inputs.predecessor);
  });

  test("the bare statement verifies with its receipt", async () => {
    const { tlog_proof: _, ...bare } = receiptOf(bridged(f));
    const r = await verifyAlibi(bare, { now, receiptKeys });
    const s = statusOf(r.checks);
    expect(s["scitt.statement"]).toBe("pass");
    expect(s["scitt.receipt"]).toBe("pass");
  });

  test("a predecessor that is not the bridged leaf fails the statement", async () => {
    const b = bridged(f);
    const other = fixtures.find((x) => x.id !== f.id);
    if (!other) throw new Error("one fixture");
    const r = await verifyAlibi({ ...b, predecessor: other.bundle.leaf }, { now, receiptKeys });
    expect(statusOf(r.checks)["scitt.statement"]).toBe("fail");
  });

  test("without its predecessor the bridge cannot be checked against the v1 leaf", async () => {
    const { predecessor: _, ...b } = bridged(f);
    const r = await verifyAlibi(b, { now, receiptKeys });
    expect(statusOf(r.checks)["scitt.statement"]).toBe("fail");
  });

  test("a v1 leaf with another body is refused", async () => {
    const b = bridged(f);
    const leaf = new TextDecoder().decode(fromBase64(f.bundle.leaf));
    const forged = toBase64(new TextEncoder().encode(leaf.replace('"mode":', '"mode" :')));
    const r = await verifyAlibi({ ...b, predecessor: forged }, { now, receiptKeys });
    expect(statusOf(r.checks)["scitt.statement"]).toBe("fail");
  });
});

describe("the bridge signer in the registry", () => {
  const f = fixtures.find((x) => x.mode === "2of2");
  if (!f) throw new Error("no 2of2 fixture");
  const b = bridged(f);
  const view = statementView(b);
  const legacy = legacyOf(b, view);
  const issuedAt = Number(f.bundle.tee.countersign.issuedAt);
  const kinds = { tdx: 1, nitro: 2 } as const;
  const answer = (bridge: Partial<ChainAnswer["signers"][number]>): ChainAnswer => ({
    rootAt: `0x${"0".repeat(64)}`,
    latest: { size: 0n, root: `0x${"0".repeat(64)}`, at: 0 },
    signers: [
      ...f.bundle.tee.attestations.map((a) => ({
        teeKind: kinds[a.kind],
        registeredAt: issuedAt - 60,
        expiresAt: issuedAt + 86_400,
        revokedAt: 0,
        measurement: measurementHex(a.measurement),
      })),
      {
        teeKind: 1,
        registeredAt: issuedAt + 86_400 * 30,
        expiresAt: issuedAt + 86_400 * 60,
        revokedAt: 0,
        measurement: `0x${"ab".repeat(32)}`,
        ...bridge,
      },
    ],
    allowed: f.bundle.tee.attestations.map(() => true),
    blocks: f.bundle.tee.attestations.map((a) =>
      (a.document as { block: { hash: string } }).block.hash.toLowerCase(),
    ) as `0x${string}`[],
    rpc: "test",
    custom: true,
  });
  const run = (a: ChainAnswer) =>
    runCheck(registry, legacy, {
      now,
      expect: undefined,
      chain: Promise.resolve(a),
      view,
      receiptKeys,
    });

  test("a TDX signer registered after the v1 issuedAt and not revoked passes", async () => {
    const c = await run(answer({}));
    expect(c.status).toBe("pass");
    expect(c.detail?.bridge_signer).toBe(vector("bridge-2of2").inputs.bridge_signer);
  });

  test("an unregistered, Nitro or revoked bridge signer fails", async () => {
    for (const bad of [{ registeredAt: 0 }, { teeKind: 2 }, { revokedAt: issuedAt + 1 }]) {
      expect((await run(answer(bad))).status).toBe("fail");
    }
  });
});
