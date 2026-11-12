import { type CurrencyCode, currencyNumeric, sha256 } from "@keelson/core";
import { amountConfirmChallenge } from "@keelson/mandate";
import { fromBase64url, toBase64url } from "../../b64.ts";
import { type CheckDef, expect, pass } from "../check.ts";
import { MANDATE_ORIGIN, MANDATE_RP_ID } from "../trust.ts";
import { rawSignature, userOf } from "./mandate.ts";
import { isBundle, UNDISCLOSED } from "./util.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * A live purchase's amount authority: what decided the amount at the pay click decided the
 * countersigned amount and currency. `paypal_order` is Keelson's API's read of PayPal's Orders
 * API, stated as such. `user_confirmed` carries the user's passkey assertion, which must verify
 * with the passkey the mandate names over the confirmation of this purchase, order, amount and
 * payee, made in the Keelson app with user verification. PayPal's checkout page alone is never an
 * authority: it stays pending.
 */
export const amountAuthority: CheckDef = {
  id: "paypal.amount_authority",
  step: 0,
  reads: ["/paypal/amount_authority", "/tee/countersign/amount", "/tee/countersign/currency"],
  async run(input) {
    if (!isBundle(input)) return UNDISCLOSED;
    const a = input.paypal?.amount_authority;
    if (a === undefined) return { status: "absent", reads: ["/paypal/amount_authority"] };
    const cs = input.tee.countersign;
    expect(
      currencyNumeric(a.total.currency as CurrencyCode) === Number(cs.currency) &&
        BigInt(a.total.minor) === BigInt(cs.amount),
      "the amount authority decided another amount than the countersigned one",
      ["/paypal/amount_authority/total", "/tee/countersign/amount", "/tee/countersign/currency"],
    );
    const detail = {
      authority: a.authority,
      ...(a.via ? { via: a.via } : {}),
      read_by: a.read_by,
      cross_check: a.cross_check,
    };
    if (a.authority === "paypal_order") return pass(detail);
    if (a.authority !== "user_confirmed") {
      return {
        status: "pending",
        reason:
          a.authority === "checkout_page"
            ? "the amount was read from PayPal's checkout page only, not confirmed"
            : "the store's signature is not carried in the Alibi",
        reads: ["/paypal/amount_authority/authority"],
      };
    }
    const assertion = a.evidence?.assertion;
    const reads = [
      "/paypal/amount_authority/evidence/assertion",
      "/mandate/payload_sd/user/cred/jwk",
    ];
    const user = userOf(input);
    const jwk = user?.jwk;
    expect(
      assertion !== undefined &&
        jwk?.kty === "EC" &&
        jwk.crv === "P-256" &&
        user?.id === assertion.credentialId,
      "the confirmation is not signed with the passkey the mandate names",
      reads,
    );
    const clientData = fromBase64url(assertion.clientDataJSON);
    const authData = fromBase64url(assertion.authenticatorData);
    const data = JSON.parse(decoder.decode(clientData)) as Record<string, unknown>;
    const challenge = toBase64url(
      amountConfirmChallenge({
        purchase_id: input.alibi_id,
        order_id_hash: a.order_id_hash as `0x${string}`,
        currency: a.total.currency,
        minor: a.total.minor,
        payee: a.payee,
      }),
    );
    expect(
      (data.type === "webauthn.get" || data.type === "payment.get") &&
        data.challenge === challenge &&
        data.origin === MANDATE_ORIGIN &&
        (data.crossOrigin === undefined || data.crossOrigin === false),
      "the assertion is not over this purchase's amount confirmation from the Keelson app",
      ["/paypal/amount_authority/evidence/assertion/clientDataJSON", "/paypal/amount_authority"],
    );
    const rpIdHash = sha256(encoder.encode(MANDATE_RP_ID));
    expect(
      authData.length === 37 &&
        rpIdHash.every((b, i) => b === authData[i]) &&
        ((authData[32] as number) & 0x05) === 0x05,
      "the authenticator data is not a user-verified assertion for keelson.finance",
      ["/paypal/amount_authority/evidence/assertion/authenticatorData"],
    );
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signed = new Uint8Array(authData.length + 32);
    signed.set(authData, 0);
    signed.set(sha256(clientData), authData.length);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      rawSignature(fromBase64url(assertion.signature)) as Uint8Array<ArrayBuffer>,
      signed,
    );
    expect(ok, "the confirmation's passkey signature does not verify", reads);
    return pass(detail);
  },
};
