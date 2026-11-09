import { toBase64url } from "../../b64.ts";
import { leafHashOf } from "../../codec.ts";
import { type CheckDef, expect, pass } from "../check.ts";

const hexToB64url = (hex: string) =>
  toBase64url(Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16)));

/** The leaf hash, anchored size and chain a QR link states are this Alibi's. */
export const qr: CheckDef = {
  id: "qr.leaf",
  step: 0,
  reads: ["/leaf", "/anchor/anchored_size", "/anchor/chain_id"],
  run(input, { expect: want }) {
    if (!want) return { status: "absent" };
    const stated = /^[0-9a-f]{64}$/i.test(want.leafHash)
      ? hexToB64url(want.leafHash)
      : want.leafHash;
    expect(stated === toBase64url(leafHashOf(input)), "the QR link names another leaf", ["/leaf"]);
    const a = input.anchor;
    if (want.chainId !== undefined && a) {
      expect(want.chainId === a.chain_id, "the QR link names another chain", ["/anchor/chain_id"]);
    }
    if (want.anchoredSize && a) {
      expect(
        want.anchoredSize === BigInt(a.anchored_size),
        "the QR link names another anchored size",
        ["/anchor/anchored_size"],
      );
    }
    return pass();
  },
};
