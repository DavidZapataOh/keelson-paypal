import { describe, expect, test } from "vitest";
import { issueAp2Open, openPayload } from "../src/ap2.ts";
import { BindingError } from "../src/bindings.ts";
import { purchaseFacts } from "../src/facts.ts";
import { sdHash } from "../src/jose.ts";
import type { ExportSigner } from "../src/signer.ts";
import { ALLOW_CARD, ALLOW_PAYPAL, alibi, refFor, testIssuer } from "./fixtures.ts";
import { errors } from "./schemas.ts";

const AP2 = "https://ap2-protocol.org/schemas";

/** The disclosed delegate payload of a root SD-JWT. */
function delegate(token: string): Record<string, unknown> & { constraints: { type: string }[] } {
  const disclosures = token.split("~").slice(1, -1);
  const [, value] = JSON.parse(Buffer.from(disclosures[0] as string, "base64url").toString());
  return value;
}

async function open(id: string, issuer?: ExportSigner) {
  return issueAp2Open(purchaseFacts(alibi(id)), refFor(id), issuer ?? (await testIssuer(id)));
}

describe("AP2 v0.2 open mandates", () => {
  test.each([ALLOW_PAYPAL, ALLOW_CARD])("%s validates against the official schemas", async (id) => {
    const o = await open(id);
    expect(errors(`${AP2}/open_checkout_mandate`, delegate(o.checkout))).toEqual([]);
    expect(errors(`${AP2}/payment_mandate_open.json`, delegate(o.payment))).toEqual([]);
  });

  test("amount_range in minor units, budget in major units, as the AP2 SDK reads them", async () => {
    const o = await open(ALLOW_PAYPAL);
    expect(delegate(o.payment).constraints).toEqual(
      expect.arrayContaining([
        { type: "payment.amount_range", currency: "USD", max: 10000 },
        { type: "payment.budget", currency: "USD", max: 100 },
        { type: "payment.agent_recurrence", frequency: "ON_DEMAND" },
      ]),
    );
  });

  test("the payment mandate references the checkout mandate by sd_hash", async () => {
    const o = await open(ALLOW_PAYPAL);
    expect(delegate(o.payment).constraints).toContainEqual({
      type: "payment.reference",
      conditional_transaction_id: sdHash(o.checkout),
    });
  });

  test("both delegate to the agent's cnf key", async () => {
    const o = await open(ALLOW_PAYPAL);
    const cnf = purchaseFacts(alibi(ALLOW_PAYPAL)).mandate.agent?.cnf;
    expect(delegate(o.checkout).cnf).toEqual(cnf);
    expect(delegate(o.payment).cnf).toEqual(cnf);
  });

  test("no Keelson-only constraint type is exported; they ride in keelson.constraints", async () => {
    const o = await open(ALLOW_PAYPAL);
    for (const token of [o.checkout, o.payment]) {
      expect(delegate(token).constraints.every((c) => /^(checkout|payment)\./.test(c.type))).toBe(
        true,
      );
    }
    const keelson = openPayload(o.checkout).keelson as { constraints: { type: string }[] };
    expect(keelson.constraints.map((c) => c.type)).toEqual([
      "keelson.category",
      "keelson.attributes",
      "keelson.returns",
    ]);
    const card = await open(ALLOW_CARD);
    expect(
      (openPayload(card.payment).keelson as { constraints: { type: string }[] }).constraints.map(
        (c) => c.type,
      ),
    ).toEqual(["keelson.category", "payment.card_controls"]);
  });

  test("carries the statement and the passkey-signed mandate byte-identical", async () => {
    const b = alibi(ALLOW_PAYPAL);
    const o = await open(ALLOW_PAYPAL);
    expect(openPayload(o.checkout).keelson).toMatchObject({
      profile: "ap2.open/1",
      statement: refFor(ALLOW_PAYPAL).statement,
      l2: b.mandate.sd_jwt,
      user_auth: b.mandate.user_auth,
    });
  });

  test("an issuer bound to other facts refuses to sign", async () => {
    await expect(open(ALLOW_PAYPAL, await testIssuer(ALLOW_CARD))).rejects.toBeInstanceOf(
      BindingError,
    );
  });
});
