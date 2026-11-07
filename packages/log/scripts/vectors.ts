import { readFileSync, writeFileSync } from "node:fs";
import { type Json, jcs } from "@keelson/core";
import type { Countersign } from "@keelson/core/eip712";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Hex } from "viem";
import {
  LEAF_PREFIX,
  type LeafMode,
  leafBytes,
  leafFromCountersign,
  leafHash,
  paypalRefCommit,
} from "../src/leaf.ts";

interface Captured {
  countersign: Record<string, string>;
  digest: Hex;
  signatures: { tdx: Hex; nitro: Hex | null };
  signers: { tdx: Hex; nitro: Hex | null };
}

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<string, unknown>;

const message = (c: Record<string, string>): Countersign => ({
  requestId: c.requestId as Hex,
  mandateHash: c.mandateHash as Hex,
  mandateCommitment: c.mandateCommitment as Hex,
  cartHash: c.cartHash as Hex,
  agentId: BigInt(c.agentId as string),
  merchantId: c.merchantId as Hex,
  amount: BigInt(c.amount as string),
  currency: Number(c.currency),
  category: Number(c.category),
  evidenceRoot: c.evidenceRoot as Hex,
  evalHash: c.evalHash as Hex,
  policySetHash: c.policySetHash as Hex,
  decision: Number(c.decision),
  failedFieldsMask: Number(c.failedFieldsMask),
  issuedAt: Number(c.issuedAt),
  expiresAt: Number(c.expiresAt),
});

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const text = (s: string) => b64(new TextEncoder().encode(s));

/** The leaf vectors shared by the TypeScript builder and the log's Go parser, as JSON text. */
export function vectors(): string {
  const twoOfTwo = read("../../core/test/vectors/countersign-2of2.json");
  const degraded = read("../../core/test/vectors/countersign-degraded.json");
  const measured = read("../../../engine/tee/measurements.json") as {
    tdx: { id: string };
    nitro: { id: string };
  };
  const domain = twoOfTwo.domain as { chainId: number; verifyingContract: Hex };
  const ref = paypalRefCommit(
    new Uint8Array(32).fill(0x5a),
    "5O190127TN364715T",
    "0VF52814937998046",
  );

  const positive = (
    [
      ["allow", twoOfTwo.allow, "2of2", undefined],
      ["deny", twoOfTwo.deny, "2of2", undefined],
      ["degraded", degraded.degraded, "degraded", undefined],
      ["allow-chained", twoOfTwo.allow, "2of2", `0x${"ab".repeat(32)}`],
      ["degraded-chained", degraded.degraded, "degraded", `0x${"cd".repeat(32)}`],
    ] as [string, Captured, LeafMode, Hex | undefined][]
  ).map(([name, v, mode, prev]) => {
    const measurements = {
      tdx: measured.tdx.id,
      nitro: mode === "2of2" ? measured.nitro.id : null,
    };
    const leaf = leafBytes(
      leafFromCountersign(
        message(v.countersign),
        v.digest,
        mode,
        v.signatures,
        measurements,
        ref,
        prev,
      ),
    );
    return {
      name,
      mode,
      leaf: b64(leaf),
      size: leaf.length,
      leafHash: bytesToHex(leafHash(leaf)),
      countersign: v.countersign,
      digest: v.digest,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
      signers: v.signers,
      measurements,
    };
  });

  const allow = new TextDecoder().decode(Buffer.from(positive[0]?.leaf as string, "base64"));
  const deg = new TextDecoder().decode(Buffer.from(positive[2]?.leaf as string, "base64"));
  const body = (leaf: string) => JSON.parse(leaf.slice(LEAF_PREFIX.length)) as Record<string, Json>;
  const canonical = (o: Record<string, Json>) => LEAF_PREFIX + jcs(o);
  const a = body(allow);
  const d = body(deg);
  const { mode: _mode, ...noMode } = a;
  const reordered = `${LEAF_PREFIX}{"alibi_id":${JSON.stringify(a.alibi_id)},${jcs(a)
    .slice(1)
    .replace(`"alibi_id":${JSON.stringify(a.alibi_id)},`, "")}`;
  const sigs = a.tee_sigs as string[];
  const ms = a.measurements as string[];
  const negative: { name: string; leaf: string; code: string }[] = [
    {
      name: "wrong prefix",
      leaf: text(allow.replace("alibi/v1", "alibi/v2")),
      code: "leaf.prefix",
    },
    { name: "extra key", leaf: text(canonical({ ...a, email: "a@b.c" })), code: "leaf.unknown" },
    { name: "reordered keys", leaf: text(reordered), code: "leaf.noncanonical" },
    {
      name: "a space",
      leaf: text(allow.replace('"mode":', '"mode": ')),
      code: "leaf.noncanonical",
    },
    {
      name: "hex instead of base64url",
      leaf: text(canonical({ ...a, cart_hash: `0x${"11".repeat(32)}` })),
      code: "leaf.field",
    },
    {
      name: "1,025 bytes",
      leaf: text(canonical({ ...a, pad: "x".repeat(1025 - canonical(a).length - 9) })),
      code: "leaf.size",
    },
    { name: "mode missing", leaf: text(canonical(noMode)), code: "leaf.mode" },
    { name: "mode 1of2", leaf: text(canonical({ ...a, mode: "1of2" })), code: "leaf.mode" },
    {
      name: "2of2 with one signature",
      leaf: text(
        canonical({ ...a, tee_sigs: [sigs[0] as string], measurements: [ms[0] as string] }),
      ),
      code: "leaf.mode",
    },
    {
      name: "degraded with two signatures",
      leaf: text(canonical({ ...a, mode: "degraded" })),
      code: "leaf.mode",
    },
    {
      name: "degraded with one signature but two measurements",
      leaf: text(canonical({ ...d, measurements: ms })),
      code: "leaf.mode",
    },
  ];
  return `${JSON.stringify({ positive, negative }, null, 2)}\n`;
}

if (import.meta.main) {
  writeFileSync(new URL("../test/vectors/leaf.json", import.meta.url), vectors());
}
