import { decodeProtectedHeader } from "jose";
import { describe, expect, test } from "vitest";
import { BindingError } from "../src/bindings.ts";
import { jwtPayload } from "../src/jose.ts";
import type { ExportSigner } from "../src/signer.ts";
import { closeVi, exportVi, VI_L1_VCT, type ViExport, verifyVi } from "../src/vi.ts";
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

type Constraint = { type: string } & Record<string, unknown>;

/** The disclosed values of an SD-JWT presentation `jwt~d1~…~`. */
const disclosed = (sdJwt: string): unknown[] =>
  sdJwt
    .split("~")
    .slice(1)
    .filter(Boolean)
    .map((d) => JSON.parse(Buffer.from(d, "base64url").toString()).at(-1));

function mandate(
  x: ViExport,
  vct: string,
): { constraints: Constraint[] } & Record<string, unknown> {
  const found = disclosed(x.l2).find(
    (v) => typeof v === "object" && v !== null && (v as { vct?: string }).vct === vct,
  );
  if (!found) throw new Error(`no ${vct} disclosed`);
  return found as { constraints: Constraint[] };
}

async function exported(id: string, close = true) {
  const issuer = await testIssuer(id);
  const agent = await testAgent();
  const f = factsFor(id, agent);
  const x = await exportVi(f, refFor(id), close ? { issuer, agent } : { issuer }, { now: NOW });
  return { x, issuer, agent, f };
}

const failed = async (issuer: ExportSigner, x: ViExport) =>
  (await verifyVi(x, { now: NOW, issuerKeys: [issuer.jwk] })).checks
    .filter((c) => !c.ok)
    .map((c) => c.id);

describe("Mastercard Verifiable Intent v0.1", () => {
  test.each([ALLOW_PAYPAL, ALLOW_CARD])("%s verifies as a full chain", async (id) => {
    const { x, issuer } = await exported(id);
    const report = await verifyVi(x, { now: NOW, issuerKeys: [issuer.jwk] });
    expect(report.format).toBe("vi");
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("L1 is the issuer's credential and binds the issuer's own key", async () => {
    const { x, issuer } = await exported(ALLOW_PAYPAL);
    const l1 = x.l1.split("~")[0] as string;
    expect(decodeProtectedHeader(l1).typ).toBe("sd+jwt");
    expect(jwtPayload(l1)).toMatchObject({ vct: VI_L1_VCT, cnf: { jwk: issuer.jwk } });
    const l2 = x.l2.split("~")[0] as string;
    expect(decodeProtectedHeader(l2).typ).toBe("kb-sd-jwt+kb");
  });

  test.each([ALLOW_PAYPAL, ALLOW_CARD, DENY_PAYPAL])(
    "%s states only VI constraint types in its mandates",
    async (id) => {
      const { x } = await exported(id);
      const checkout = mandate(x, "mandate.checkout.open.1").constraints.map((c) => c.type);
      const payment = mandate(x, "mandate.payment.open.1").constraints.map((c) => c.type);
      for (const t of checkout) {
        expect(["mandate.checkout.allowed_merchants", "mandate.checkout.line_items"]).toContain(t);
      }
      for (const t of payment) {
        expect([
          "mandate.payment.amount_range",
          "mandate.payment.allowed_payees",
          "mandate.payment.reference",
          "mandate.payment.budget",
        ]).toContain(t);
      }
      expect(checkout).toContain("mandate.checkout.line_items");
      expect(payment).toContain("mandate.payment.reference");
    },
  );

  test("amounts are minor units; Keelson-only constraints ride in keelson.constraints", async () => {
    const { x } = await exported(ALLOW_PAYPAL);
    expect(mandate(x, "mandate.payment.open.1").constraints).toEqual(
      expect.arrayContaining([
        { type: "mandate.payment.amount_range", currency: "USD", max: 10000 },
        { type: "mandate.payment.budget", currency: "USD", max: 10000 },
      ]),
    );
    const keelson = jwtPayload(x.l2).keelson as { constraints: Constraint[] };
    expect(keelson.constraints.map((c) => c.type)).toEqual([
      "keelson.category",
      "keelson.attributes",
      "keelson.returns",
      "payment.execution_date",
    ]);
  });

  test("a wildcard merchant is no VI constraint; a wildcard line is stated as the checked cart", async () => {
    const { x } = await exported(ALLOW_CARD);
    const checkout = mandate(x, "mandate.checkout.open.1").constraints;
    expect(checkout.map((c) => c.type)).toEqual(["mandate.checkout.line_items"]);
    const items = disclosed(x.l2).filter(
      (v) => typeof v === "object" && v !== null && "title" in v && !("vct" in v),
    );
    expect(items).toEqual([{ id: "hsc-house-blend-12oz", title: "hsc-house-blend-12oz" }]);
    expect(jwtPayload(x.l2).keelson).toMatchObject({ refined: ["checkout.line_items"] });
  });

  test("the L2 carries the Alibi's Transparent Statement as its agent attestation", async () => {
    const { x } = await exported(ALLOW_PAYPAL);
    expect(jwtPayload(x.l2).agent_attestation).toEqual({
      type: "application/scitt-statement+cose",
      value: refFor(ALLOW_PAYPAL).statement,
    });
  });

  test("L3a goes to PayPal, L3b to the merchant, both nonced with the countersigned request", async () => {
    const { x } = await exported(ALLOW_PAYPAL);
    const l3a = x.l3_payment?.split("~")[0] as string;
    const l3b = x.l3_checkout?.split("~")[0] as string;
    expect(decodeProtectedHeader(l3a).typ).toBe("kb-sd-jwt");
    expect(jwtPayload(l3a)).toMatchObject({ aud: "https://www.paypal.com", nonce: ALLOW_PAYPAL });
    expect(jwtPayload(l3b)).toMatchObject({ aud: "https://runfast.example", nonce: ALLOW_PAYPAL });
    expect(x.nonce).toBe(ALLOW_PAYPAL);
  });

  test("without the agent's key the L3s are left for the agent to sign", async () => {
    const { x, issuer, agent } = await exported(ALLOW_PAYPAL, false);
    expect(x.l3_payment).toBeUndefined();
    expect(x.pending_close).toBeDefined();
    const closed = await closeVi(x, agent, { now: NOW });
    expect(closed.pending_close).toBeUndefined();
    expect(await failed(issuer, closed)).toEqual([]);
    const stranger = await closeVi(x, await testAgent(), { now: NOW });
    expect(await failed(issuer, stranger)).toContain("chain_binding");
  });

  test("an unknown issuer key fails the issuer check", async () => {
    const { x } = await exported(ALLOW_PAYPAL);
    const report = await verifyVi(x, { now: NOW, issuerKeys: [] });
    expect(report.checks.find((c) => !c.ok)?.id).toBe("issuer");
  });

  test("an issuer bound to another purchase's statement refuses to sign", async () => {
    const issuer = await testIssuer(ALLOW_CARD);
    const agent = await testAgent();
    await expect(
      exportVi(
        factsFor(ALLOW_PAYPAL, agent),
        refFor(ALLOW_PAYPAL),
        { issuer, agent },
        { now: NOW },
      ),
    ).rejects.toBeInstanceOf(BindingError);
  });
});
