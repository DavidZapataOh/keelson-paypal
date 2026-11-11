import { fromHex } from "@keelson/core";
import { CARD_BITS, cardAuthorizationDigest, keelsonDomain } from "@keelson/core/eip712";
import { cardRefCommit } from "@keelson/log";
import { type Address, getAddress, type Hex, recoverAddress } from "viem";
import { type CheckDef, expect, pass } from "../check.ts";
import { b64urlOfHex, isBundle, UNDISCLOSED } from "./util.ts";

/**
 * The leaf's payment commitment opens to this issuer and card, and every approved card
 * authorization carries both legs' `CardAuthorization` of this countersign, approving it: each
 * signed by the leg that countersigned, over this request and this countersign's digest.
 */
export const card: CheckDef = {
  id: "card.authorizations",
  step: 0,
  reads: ["/card"],
  async run(input) {
    if (!isBundle(input)) return UNDISCLOSED;
    if (input.card === undefined) return { status: "absent" };
    const k = input.card;
    const tee = input.tee;
    expect(
      b64urlOfHex(cardRefCommit(fromHex(k.ref_salt), k.issuer, k.card_token)) ===
        input.leaf_view.paypal_ref_commit,
      "the leaf's payment commitment does not open to this card",
      ["/card/ref_salt", "/card/issuer", "/card/card_token", "/leaf_view/paypal_ref_commit"],
    );
    const approved = k.authorizations.filter((a) => a.approved);
    expect(approved.length <= 1, "a single-use card approved more than one authorization", [
      "/card/authorizations",
    ]);
    const domain = keelsonDomain(
      tee.domain.chain_id as 421614 | 42161,
      tee.domain.verifying_contract as Hex,
    );
    const signerOf = (kind: "tdx" | "nitro") =>
      tee.signatures.find((s) => s.kind === kind)?.signer as Address | undefined;
    for (const [i, a] of k.authorizations.entries()) {
      const at = `/card/authorizations/${i}`;
      if (!a.approved) continue;
      for (const kind of ["tdx", "nitro"] as const) {
        const v = a.verdicts.find((x) => x.kind === kind);
        expect(v, `the ${kind} leg's approval is missing`, [`${at}/verdicts`]);
        const m = v.authorization;
        const digest = cardAuthorizationDigest(
          {
            requestId: m.requestId as Hex,
            countersignDigest: m.countersignDigest as Hex,
            authorizationHash: m.authorizationHash as Hex,
            merchantHash: m.merchantHash as Hex,
            mcc: Number(m.mcc),
            country: m.country as Hex,
            amount: BigInt(m.amount ?? "0"),
            currency: Number(m.currency),
            decision: Number(m.decision),
            failedMask: Number(m.failedMask),
            issuedAt: Number(m.issuedAt),
          },
          domain,
        );
        expect(digest === v.digest, "digest", [`${at}/verdicts`]);
        const recovered = getAddress(
          await recoverAddress({ hash: digest, signature: v.signature as Hex }),
        );
        expect(
          recovered === getAddress(v.signer) && recovered === signerOf(kind),
          `the ${kind} approval is not signed by the leg that countersigned`,
          [`${at}/verdicts`, "/tee/signatures"],
        );
        expect(
          m.requestId === tee.countersign.requestId && m.countersignDigest === tee.digest,
          `the ${kind} approval names another countersign`,
          [`${at}/verdicts`, "/tee/countersign/requestId", "/tee/digest"],
        );
        expect(
          m.decision === "1" &&
            m.failedMask === "0" &&
            BigInt(m.amount ?? "0") === BigInt(a.amount_minor),
          `the ${kind} leg did not approve this amount`,
          [`${at}/verdicts`, `${at}/amount_minor`],
        );
        expect(
          BigInt(a.amount_minor) <= BigInt(tee.countersign.amount),
          "the card authorization is above the countersigned amount",
          [`${at}/amount_minor`, "/tee/countersign/amount"],
        );
      }
    }
    return pass({
      authorizations: String(k.authorizations.length),
      approved: String(approved.length),
      ...(k.settlement ? { settled_minor: k.settlement.settled_minor } : {}),
    });
  },
};

/** The reasons a leg's `failedMask` names, by name. */
export function cardReasons(failedMask: number): string[] {
  return Object.entries(CARD_BITS)
    .filter(([, bit]) => (failedMask >> bit) & 1)
    .map(([name]) => name);
}
