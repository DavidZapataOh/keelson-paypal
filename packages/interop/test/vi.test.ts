import { describe, expect, it } from "vitest";
import { checkoutJwt, instrumentOf } from "../src/ap2.ts";
import { purchaseFacts } from "../src/facts.ts";
import { disclosedPayload, hashB64u, jwtPayload } from "../src/jose.ts";
import { closeVi, issueViL2, VI_L1_VCT } from "../src/vi.ts";
import { ALLOWED, alibi, freshSigner } from "./fixtures.ts";

async function exported() {
  const f = purchaseFacts(alibi(ALLOWED));
  const keelson = await freshSigner();
  const agent = await freshSigner();
  const mandate = {
    ...f.mandate,
    agent: { ...f.mandate.agent, cnf: { jwk: { ...agent.jwk, kid: agent.kid } } },
  };
  const chain = await issueViL2(mandate, keelson, {
    mandateHash: f.mandateHash,
    iss: "https://keelson.finance",
    instrument: instrumentOf(mandate),
    payee: f.payee,
  });
  const l3 = await closeVi(chain, { ...f, mandate }, await checkoutJwt(f, keelson), agent, {
    nonce: "n-1",
    iat: f.issuedAt,
    networkAud: "https://www.paypal.com",
    merchantAud: "https://runfast.example",
  });
  return { f, keelson, agent, chain, l3 };
}

const header = (token: string) =>
  JSON.parse(atob((token.split(".")[0] as string).replace(/-/g, "+").replace(/_/g, "/")));

describe("Verifiable Intent v0.1", () => {
  it("issues L1 as sd+jwt binding Keelson's key, with the login id selectively disclosed", async () => {
    const { chain, keelson } = await exported();
    expect(header(chain.l1)).toEqual({ typ: "sd+jwt", kid: keelson.kid, alg: "ES256" });
    const l1 = disclosedPayload(chain.l1);
    expect(l1).toMatchObject({
      vct: VI_L1_VCT,
      cnf: { jwk: keelson.jwk },
      email: "andres@example.com",
    });
    expect(l1).not.toHaveProperty("sd_hash");
  });

  it("issues an Autonomous L2 bound to L1, delegating to the agent with mandate.* constraints", async () => {
    const { chain, agent } = await exported();
    expect(header(chain.l2).typ).toBe("kb-sd-jwt+kb");
    expect(jwtPayload(chain.l2.split("~")[0] as string).sd_hash).toBe(hashB64u(chain.l1));
    const [checkout, payment] = disclosedPayload<{ delegate_payload: Record<string, unknown>[] }>(
      chain.l2,
    ).delegate_payload;
    expect(checkout).toMatchObject({
      vct: "mandate.checkout.open.1",
      cnf: { jwk: { kid: agent.kid } },
    });
    expect(((checkout?.constraints ?? []) as { type: string }[]).map((c) => c.type)).toEqual([
      "mandate.checkout.allowed_merchants",
      "mandate.checkout.line_items",
    ]);
    expect(((payment?.constraints ?? []) as { type: string }[]).map((c) => c.type)).toEqual([
      "mandate.payment.amount_range",
      "mandate.payment.budget",
      "mandate.payment.allowed_payees",
      "mandate.payment.reference",
    ]);
  });

  it("closes with L3a for the network and L3b for the merchant, each bound to its view of L2", async () => {
    const { chain, l3, f } = await exported();
    const base = chain.l2.split("~")[0] as string;
    const a = jwtPayload(l3.l3Payment.split("~")[0] as string);
    const b = jwtPayload(l3.l3Checkout.split("~")[0] as string);
    expect(header(l3.l3Payment).typ).toBe("kb-sd-jwt");
    expect(a).toMatchObject({
      aud: "https://www.paypal.com",
      sd_hash: hashB64u(`${base}~${chain.refs.payment}~${chain.refs.payee}~`),
    });
    expect(b).toMatchObject({
      aud: "https://runfast.example",
      sd_hash: hashB64u(`${base}~${chain.refs.checkout}~${chain.refs.items.join("~")}~`),
    });
    const payment = disclosedPayload<{ delegate_payload: Record<string, unknown>[] }>(l3.l3Payment)
      .delegate_payload[1];
    expect(payment).toMatchObject({
      vct: "mandate.payment.1",
      payment_amount: { currency: "USD", amount: f.totalMinor },
    });
  });

  it("writes JSON as the reference verifier re-encodes it: compact and ASCII only", async () => {
    const { l3 } = await exported();
    const [h = "", p = ""] = (l3.l3Checkout.split("~")[0] as string).split(".");
    for (const part of [h, p]) {
      const json = new TextDecoder().decode(
        Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
      );
      expect(json).toBe(JSON.stringify(JSON.parse(json)));
      expect(/^[\x20-\x7e]*$/.test(json)).toBe(true);
    }
  });
});
