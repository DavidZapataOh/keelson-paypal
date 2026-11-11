import { describe, expect, it } from "vitest";
import {
  ap2Receipts,
  checkoutJwt,
  checkoutObject,
  closeAp2,
  instrumentOf,
  issueAp2Open,
  openPayload,
  receiptReference,
} from "../src/ap2.ts";
import { purchaseFacts } from "../src/facts.ts";
import { disclosedPayload, hashB64u, jwtPayload } from "../src/jose.ts";
import { ALLOWED, alibi, DENIED, freshSigner } from "./fixtures.ts";
import { errors } from "./schemas.ts";

const AP2 = "https://ap2-protocol.org/schemas";

async function exported(id: string) {
  const f = purchaseFacts(alibi(id));
  const keelson = await freshSigner();
  const agent = await freshSigner();
  const mandate = {
    ...f.mandate,
    agent: { ...f.mandate.agent, cnf: { jwk: { ...agent.jwk, kid: agent.kid } } },
  };
  const facts = { ...f, mandate };
  const open = await issueAp2Open(mandate, keelson, {
    mandateHash: f.mandateHash,
    instrument: instrumentOf(mandate),
  });
  const cjwt = await checkoutJwt(facts, keelson);
  const closed = await closeAp2(open, facts, cjwt, agent, { nonce: "n-1", iat: facts.issuedAt });
  const receipts = await ap2Receipts(closed, facts, keelson, {
    iss: "https://keelson.finance",
    iat: facts.issuedAt,
  });
  return { f: facts, keelson, agent, open, closed, receipts };
}

describe("AP2 v0.2 open mandates", () => {
  it("validate against open_checkout_mandate.json and open_payment_mandate.json", async () => {
    const { open } = await exported(ALLOWED);
    expect(errors(`${AP2}/open_checkout_mandate`, openPayload(open.checkout))).toEqual([]);
    expect(errors(`${AP2}/payment_mandate_open.json`, openPayload(open.payment))).toEqual([]);
  });

  it("bind the payment mandate to the checkout mandate by its sd_hash", async () => {
    const { open } = await exported(ALLOWED);
    const reference = (
      openPayload(open.payment).constraints as {
        type: string;
        conditional_transaction_id?: string;
      }[]
    ).find((c) => c.type === "payment.reference");
    expect(reference?.conditional_transaction_id).toBe(hashB64u(open.checkout));
  });

  it("delegate to the agent key and carry M", async () => {
    const { open, agent, f } = await exported(ALLOWED);
    const p = openPayload(open.checkout);
    expect(p.cnf).toEqual({ jwk: { ...agent.jwk, kid: agent.kid } });
    expect(p.keelson).toMatchObject({ mandate_hash: f.mandateHash });
  });

  it("state the budget as ON_DEMAND recurrence, in the major units the AP2 SDK reads", async () => {
    const { open } = await exported(ALLOWED);
    expect(openPayload(open.payment).constraints).toEqual(
      expect.arrayContaining([
        { type: "payment.amount_range", currency: "USD", max: 10000 },
        { type: "payment.agent_recurrence", frequency: "ON_DEMAND" },
        { type: "payment.budget", max: 100, currency: "USD" },
      ]),
    );
  });

  it("export no Keelson-only constraint type", async () => {
    const { open } = await exported(ALLOWED);
    for (const token of [open.checkout, open.payment]) {
      const types = (openPayload(token).constraints as { type: string }[]).map((c) => c.type);
      expect(types.every((t) => t.startsWith("checkout.") || t.startsWith("payment."))).toBe(true);
    }
  });
});

describe("AP2 v0.2 closed mandates", () => {
  it("validate against checkout_mandate.json and payment_mandate.json, and the checkout against UCP's", async () => {
    const { closed } = await exported(ALLOWED);
    const leaf = (chain: string) =>
      disclosedPayload<{ delegate_payload: Record<string, unknown>[] }>(
        chain.split("~~")[1] as string,
      ).delegate_payload[0];
    const checkout = leaf(closed.checkout) as { checkout_jwt: string };
    expect(errors(`${AP2}/checkout_mandate.json`, checkout)).toEqual([]);
    expect(errors(`${AP2}/payment_mandate.json`, leaf(closed.payment))).toEqual([]);
    expect(errors(`${AP2}/types/checkout.json`, jwtPayload(checkout.checkout_jwt))).toEqual([]);
  });

  it("are terminal hops signed by the agent and bound to the open mandate", async () => {
    const { closed, open, agent } = await exported(ALLOWED);
    const [, hop = ""] = closed.checkout.split("~~");
    const jwt = hop.split("~")[0] as string;
    const header = JSON.parse(atob(jwt.split(".")[0] as string));
    expect(header).toEqual({ typ: "kb+sd-jwt", kid: agent.kid, alg: "ES256" });
    expect(jwtPayload(jwt)).toMatchObject({
      aud: "merchant",
      nonce: "n-1",
      sd_hash: hashB64u(open.checkout),
    });
  });

  it("pay the checkout they name: transaction_id is the checkout_hash", async () => {
    const { closed } = await exported(ALLOWED);
    const payment = disclosedPayload<{ delegate_payload: { transaction_id: string }[] }>(
      closed.payment.split("~~")[1] as string,
    );
    expect(payment.delegate_payload[0]?.transaction_id).toBe(hashB64u(closed.checkoutJwt));
  });

  it("checkout is the countersigned purchase", async () => {
    const { f } = await exported(ALLOWED);
    expect(checkoutObject(f)).toMatchObject({
      id: "8MY937060S1606416",
      currency: "USD",
      line_items: [
        { item: { id: "sku-trail-10", title: "Trail running shoe", price: 100 }, quantity: 1 },
      ],
      totals: [
        { type: "subtotal", amount: 100 },
        { type: "total", amount: 100 },
      ],
    });
  });
});

describe("AP2 v0.2 receipts", () => {
  it("validate against the receipt schemas and reference the closed mandates", async () => {
    const { receipts, closed } = await exported(ALLOWED);
    const checkout = jwtPayload(receipts.checkout);
    const payment = jwtPayload(receipts.payment);
    expect(errors(`${AP2}/checkout_receipt.json`, checkout)).toEqual([]);
    expect(errors(`${AP2}/payment_receipt.json`, payment)).toEqual([]);
    expect(checkout.reference).toBe(receiptReference(closed.checkout));
    expect(payment).toMatchObject({ status: "Success", psp_confirmation_id: "5VK089183A260134T" });
  });

  it("report a refused cart as an Error payment receipt", async () => {
    const { receipts } = await exported(DENIED);
    const payment = jwtPayload(receipts.payment);
    expect(errors(`${AP2}/payment_receipt.json`, payment)).toEqual([]);
    expect(payment).toMatchObject({ status: "Error", error: "declined" });
  });
});
