import { describe, expect, test } from "vitest";
import { type Ap2Export, closeAp2, exportAp2, receiptReference, verifyAp2 } from "../src/ap2.ts";
import { BindingError } from "../src/bindings.ts";
import { b64uSha256, jwtPayload } from "../src/jose.ts";
import type { ExportSigner } from "../src/signer.ts";
import {
  ALLOW_CARD,
  ALLOW_PAYPAL,
  DENY_PAYPAL,
  factsFor,
  NOW,
  refFor,
  testAgent,
  testIssuer,
} from "./fixtures.ts";
import { errors } from "./schemas.ts";

const AP2 = "https://ap2-protocol.org/schemas";

/** The disclosed delegate payload of the last segment of a chain. */
function leaf(chain: string): Record<string, unknown> {
  const last = chain.split("~~").at(-1) as string;
  const [, value] = JSON.parse(Buffer.from(last.split("~")[1] as string, "base64url").toString());
  return value;
}

async function exported(id: string, close = true) {
  const issuer = await testIssuer(id);
  const agent = await testAgent();
  const f = factsFor(id, agent);
  const x = await exportAp2(f, refFor(id), close ? { issuer, agent } : { issuer }, { now: NOW });
  return { x, issuer, agent, f };
}

const ok = (issuer: ExportSigner, x: Ap2Export) =>
  verifyAp2(x, { now: NOW, issuerKeys: [issuer.jwk] });
const failed = async (issuer: ExportSigner, x: Ap2Export) =>
  (await ok(issuer, x)).checks.filter((c) => !c.ok).map((c) => c.id);

describe("AP2 v0.2 closed mandates and receipts", () => {
  test.each([ALLOW_PAYPAL, ALLOW_CARD, DENY_PAYPAL])(
    "%s validates against the official schemas",
    async (id) => {
      const { x } = await exported(id);
      expect(errors(`${AP2}/checkout_mandate.json`, leaf(x.checkout.closed as string))).toEqual([]);
      expect(errors(`${AP2}/payment_mandate.json`, leaf(x.payment.closed as string))).toEqual([]);
      expect(errors(`${AP2}/types/checkout.json`, jwtPayload(x.checkout.checkout_jwt))).toEqual([]);
      expect(
        errors(`${AP2}/checkout_receipt.json`, jwtPayload(x.checkout.receipt as string)),
      ).toEqual([]);
      expect(
        errors(`${AP2}/payment_receipt.json`, jwtPayload(x.payment.receipt as string)),
      ).toEqual([]);
    },
  );

  test("a successful checkout receipt names its order, as AP2's SDK requires", async () => {
    for (const id of [ALLOW_PAYPAL, ALLOW_CARD]) {
      const { x } = await exported(id);
      expect(jwtPayload(x.checkout.receipt as string).order_id).toBeTypeOf("string");
    }
  });

  test("verify as a dispute bundle: chains, checkout hash and receipt references", async () => {
    const { x, issuer } = await exported(ALLOW_PAYPAL);
    expect(await failed(issuer, x)).toEqual([]);
    expect(jwtPayload(x.payment.receipt as string).reference).toBe(
      receiptReference(x.payment.closed as string),
    );
    expect(leaf(x.payment.closed as string).transaction_id).toBe(
      b64uSha256(x.checkout.checkout_jwt),
    );
  });

  test("the closed nonce is the countersigned request, as a ULID", async () => {
    const { x } = await exported(ALLOW_PAYPAL);
    const closedJwt = (x.payment.closed as string).split("~~").at(-1)?.split("~")[0] as string;
    expect(jwtPayload(closedJwt)).toMatchObject({ nonce: ALLOW_PAYPAL, aud: "paypal" });
  });

  test("without the agent's key the open chain is exported with what the agent must close", async () => {
    const { x, issuer, agent } = await exported(ALLOW_PAYPAL, false);
    expect(x.checkout.closed).toBeUndefined();
    expect(x.pending_close).toBeDefined();
    const closed = await closeAp2(x, agent, { now: NOW });
    expect(await failed(issuer, closed)).toEqual([]);
    const stranger = await closeAp2(x, await testAgent(), { now: NOW });
    expect(await failed(issuer, stranger)).toContain("chain_binding");
  });

  test("a refused cart gets an Error payment receipt, and the issuer will not sign Success", async () => {
    const { x, f } = await exported(DENY_PAYPAL);
    expect(jwtPayload(x.payment.receipt as string)).toMatchObject({
      status: "Error",
      error: "declined",
    });
    const issuer = await testIssuer(DENY_PAYPAL);
    await expect(
      issuer.sign(
        "JWT",
        { ...jwtPayload(x.payment.receipt as string), status: "Success" },
        refFor(DENY_PAYPAL).statement,
      ),
    ).rejects.toBeInstanceOf(BindingError);
    expect(f.decision).toBe("deny");
  });

  test("a card purchase is confirmed by its approved authorization", async () => {
    const { x } = await exported(ALLOW_CARD);
    expect(jwtPayload(x.payment.receipt as string)).toMatchObject({
      psp_confirmation_id: "5833c23b-eca7-43ae-95c8-9917d8c9ffff",
      network_confirmation_id: "5833c23b-eca7-43ae-95c8-9917d8c9ffff",
    });
  });

  test("without a disclosed cart the checkout states only its total", async () => {
    const { x } = await exported(ALLOW_PAYPAL);
    const checkout = jwtPayload(x.checkout.checkout_jwt);
    expect(checkout.line_items).toEqual([]);
    expect(checkout.totals).toEqual([{ type: "total", amount: 100 }]);
  });

  test("must reject: an intermediate audience, a foreign nonce and an unknown issuer", async () => {
    const { x, issuer, agent } = await exported(ALLOW_PAYPAL, false);
    const wrongAud = await closeAp2(x, agent, { now: NOW, aud: { payment: "evil" } });
    expect(await failed(issuer, wrongAud)).toContain("chain_binding");
    const wrongNonce = await closeAp2(x, agent, { now: NOW, nonce: "01M6ZWZJHWRRHQEYNJAT7NMSV9" });
    expect(await failed(issuer, wrongNonce)).toContain("nonce");
    const closed = await closeAp2(x, agent, { now: NOW });
    expect(
      (await verifyAp2(closed, { now: NOW, issuerKeys: [] })).checks.find((c) => !c.ok)?.id,
    ).toBe("issuer");
  });
});
