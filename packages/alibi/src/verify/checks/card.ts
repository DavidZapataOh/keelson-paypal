import { CURRENCIES, type CurrencyCode, fromHex } from "@keelson/core";
import { cardAuthorizationDigest, keelsonDomain } from "@keelson/core/eip712";
import { cardRefCommit } from "@keelson/log";
import { type Address, getAddress, type Hex, keccak256, recoverAddress, toHex } from "viem";
import { type CheckDef, expect, pass } from "../check.ts";
import { b64urlOfHex, isBundle, UNDISCLOSED } from "./util.ts";

/**
 * The leaf's payment commitment opens to this issuer and card, and every authorization shown is
 * the one the legs signed: its id, amount, currency, merchant code, country and merchant. An
 * authorization counts as approved exactly when both legs that countersigned signed an approval
 * of it under this countersign, so a single-use card shows at most one, for no more than the
 * countersigned amount.
 */
export const card: CheckDef = {
  id: "card.authorizations",
  step: 0,
  reads: ["/card"],
  async run(input, { view }) {
    if (!isBundle(input)) return UNDISCLOSED;
    if (input.card === undefined) return { status: "absent" };
    const k = input.card;
    const tee = input.tee;
    expect(input.paypal === undefined, "a purchase paid both by card and through PayPal", [
      "/card",
      "/paypal",
    ]);
    // In v2 the card statements commit to the card (`card.statements`); the purchase statement cannot.
    expect(
      view !== null ||
        b64urlOfHex(cardRefCommit(fromHex(k.ref_salt), k.issuer, k.card_token)) ===
          input.leaf_view.paypal_ref_commit,
      "the leaf's payment commitment does not open to this card",
      ["/card/ref_salt", "/card/issuer", "/card/card_token", "/leaf_view/paypal_ref_commit"],
    );
    const domain = keelsonDomain(
      tee.domain.chain_id as 421614 | 42161,
      tee.domain.verifying_contract as Hex,
    );
    const signerOf = (kind: "tdx" | "nitro") =>
      tee.signatures.find((s) => s.kind === kind)?.signer as Address | undefined;
    let approved = 0;
    for (const [i, a] of k.authorizations.entries()) {
      const at = `/card/authorizations/${i}`;
      const currency = CURRENCIES[a.currency as CurrencyCode]?.numeric;
      let approvals = 0;
      for (const v of a.verdicts) {
        const m = v.authorization;
        const message = {
          requestId: m.requestId as Hex,
          countersignDigest: m.countersignDigest as Hex,
          authorizationHash: m.authorizationHash as Hex,
          merchantHash: m.merchantHash as Hex,
          mcc: Number(m.mcc),
          country: m.country as Hex,
          amount: BigInt(m.amount ?? "-1"),
          currency: Number(m.currency),
          decision: Number(m.decision),
          failedMask: Number(m.failedMask),
          issuedAt: Number(m.issuedAt),
        };
        const digest = cardAuthorizationDigest(message, domain);
        expect(digest === v.digest, "digest", [`${at}/verdicts`]);
        const recovered = getAddress(
          await recoverAddress({ hash: digest, signature: v.signature as Hex }),
        );
        expect(
          recovered === getAddress(v.signer) && recovered === signerOf(v.kind),
          `the ${v.kind} answer is not signed by the leg that countersigned`,
          [`${at}/verdicts`, "/tee/signatures"],
        );
        expect(
          message.requestId === tee.countersign.requestId &&
            message.countersignDigest === tee.digest,
          `the ${v.kind} answer names another countersign`,
          [`${at}/verdicts`, "/tee/countersign/requestId", "/tee/digest"],
        );
        expect(
          message.authorizationHash === keccak256(toHex(a.id)) &&
            message.amount === BigInt(a.amount_minor) &&
            message.currency === currency &&
            message.mcc === Number(a.mcc) &&
            message.country === toHex(a.merchant_country) &&
            message.merchantHash === keccak256(toHex(`${a.network_id}\0${a.merchant_name}`)),
          `the ${v.kind} answer is for another authorization than the one shown`,
          [at],
        );
        if (message.decision === 1 && message.failedMask === 0) approvals++;
      }
      const both = approvals === 2 && new Set(a.verdicts.map((v) => v.kind)).size === 2;
      expect(a.approved === both, "approved is not what both legs signed", [`${at}/approved`]);
      if (!both) continue;
      approved++;
      expect(
        BigInt(a.amount_minor) <= BigInt(tee.countersign.amount),
        "the card authorization is above the countersigned amount",
        [`${at}/amount_minor`, "/tee/countersign/amount"],
      );
    }
    expect(approved <= 1, "a single-use card approved more than one authorization", [
      "/card/authorizations",
    ]);
    return pass({
      authorizations: String(k.authorizations.length),
      approved: String(approved),
      ...(k.settlement ? { settled_minor: k.settlement.settled_minor } : {}),
    });
  },
};
