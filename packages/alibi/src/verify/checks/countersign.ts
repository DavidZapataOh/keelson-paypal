import { deploymentsFor } from "@keelson/chain";
import {
  type CurrencyCode,
  currencyNumeric,
  DST,
  hashObject,
  type Json,
  toHex,
} from "@keelson/core";
import { type Countersign, countersignDigest, Decision } from "@keelson/core/eip712";
import { merchantLeaf } from "@keelson/mandate";
import { getAddress, type Hex, recoverAddress } from "viem";
import type { AlibiBundle } from "../../schema.ts";
import { type CheckDef, expect, pass } from "../check.ts";
import { isBundle, UNDISCLOSED } from "./util.ts";

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const KINDS = { "2of2": ["tdx", "nitro"], degraded: ["tdx"] } as const;
const UINTS = [
  "agentId",
  "amount",
  "currency",
  "category",
  "decision",
  "failedFieldsMask",
  "issuedAt",
  "expiresAt",
] as const;

function message(c: AlibiBundle["tee"]["countersign"]): Countersign {
  const m: Record<string, unknown> = { ...c };
  for (const k of UINTS) m[k] = BigInt(c[k]);
  return m as unknown as Countersign;
}

/**
 * The countersignature is over this trace: the domain is the pinned verifier's, the message's
 * eval hash, amount, currency, merchant and decision are the trace's, it hashes to the digest,
 * and each signature recovers, with a low S, to the signer its attestation names.
 */
export const countersign: CheckDef = {
  id: "tee.countersign",
  step: 4,
  reads: ["/tee"],
  async run(input) {
    if (!isBundle(input)) return UNDISCLOSED;
    const { tee, eval: trace } = input;
    const d = tee.domain;
    const verifier = deploymentsFor(d.chain_id).VerdictVerifier;
    expect(
      verifier !== undefined && getAddress(d.verifying_contract) === getAddress(verifier),
      "domain",
      ["/tee/domain"],
    );
    const c = tee.countersign;
    expect(
      toHex(hashObject(DST.eval, trace as unknown as Json)) === c.evalHash,
      "evalHash in the countersignature is not the hash of this trace",
      ["/eval", "/tee/countersign/evalHash"],
    );
    const ctx = trace.context;
    expect(
      String(ctx.total_minor) === c.amount,
      "amount in the countersignature is not the trace's",
      ["/tee/countersign/amount", "/eval/context/total_minor"],
    );
    expect(
      currencyNumeric(ctx.currency as CurrencyCode) === Number(c.currency),
      "currency in the countersignature is not the trace's",
      ["/tee/countersign/currency", "/eval/context/currency"],
    );
    const merchant = await merchantLeaf(String(ctx.merchant));
    expect(
      `0x${merchant.toString(16).padStart(64, "0")}` === c.merchantId,
      "merchantId in the countersignature is not the trace's merchant",
      ["/tee/countersign/merchantId", "/eval/context/merchant"],
    );
    const decision = trace.decision === "allow" ? Decision.ALLOW : Decision.DENY;
    expect(Number(c.decision) === decision, "decision in the countersignature is not the trace's", [
      "/tee/countersign/decision",
      "/eval/decision",
    ]);
    const digest = countersignDigest(message(c), {
      name: d.name,
      version: d.version,
      chainId: d.chain_id,
      verifyingContract: d.verifying_contract as Hex,
    });
    expect(digest === tee.digest, "digest", ["/tee/digest", "/tee/countersign"]);

    const kinds = KINDS[tee.mode];
    expect(
      tee.signatures.length === kinds.length &&
        tee.attestations.length === kinds.length &&
        kinds.every((k, i) => tee.signatures[i]?.kind === k && tee.attestations[i]?.kind === k),
      "mode",
      ["/tee/mode", "/tee/signatures", "/tee/attestations"],
    );
    for (const [i, s] of tee.signatures.entries()) {
      const at = `/tee/signatures/${i}`;
      const sig = s.signature as Hex;
      expect(BigInt(`0x${sig.slice(66, 130)}`) <= SECP256K1_HALF_N, "high-S signature", [
        `${at}/signature`,
      ]);
      const signer = await recoverAddress({ hash: digest, signature: sig });
      const attested = tee.attestations[i]?.signer ?? "";
      expect(
        signer === getAddress(s.signer) && signer === getAddress(attested),
        "not the attested signer",
        [`${at}/signature`, `${at}/signer`, `/tee/attestations/${i}/signer`],
      );
    }
    return pass({ mode: tee.mode });
  },
};
