import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, test } from "vitest";
import { type AcpExport, exportAcp, verifyAcp } from "../src/acp.ts";
import { type Ap2Export, closeAp2, exportAp2, verifyAp2 } from "../src/ap2.ts";
import { exportOne } from "../src/export.ts";
import { purchaseFacts, statementFacts } from "../src/facts.ts";
import { jwtPayload, sdHash } from "../src/jose.ts";
import { ed25519Signer, exportTap, signAgentRequest, type TapExport } from "../src/tap.ts";
import { localExportSigner } from "../src/testing.ts";
import { verifyExport } from "../src/verify.ts";
import { exportVi, type ViExport } from "../src/vi.ts";
import {
  ALLOW_CARD,
  ALLOW_PAYPAL,
  alibi,
  DENY_PAYPAL,
  factsFor,
  NOW,
  refFor,
  testAgent,
  testIssuer,
} from "./fixtures.ts";
import { RECEIPT_KEYS, v2Of, v2Ref } from "./v2.ts";

const ref = v2Ref("allow-2of2");
const failedOf = (r: { checks: { id: string; ok: boolean }[] }) =>
  r.checks.filter((c) => !c.ok).map((c) => c.id);
const httpKey = async () => {
  const { privateKey } = await generateKeyPair("Ed25519", { extractable: true });
  return ed25519Signer(await exportJWK(privateKey));
};

describe("TAP trusts only pinned agent keys", () => {
  test("a request signed by a key the export carries itself does not verify", async () => {
    const agentHttp = await httpKey();
    const attacker = await httpKey();
    const genuine = (await exportTap(
      purchaseFacts(alibi(ALLOW_PAYPAL)),
      ref,
      { agentHttp },
      { now: NOW },
    )) as TapExport;
    const request = await signAgentRequest(genuine.request, attacker, {
      tag: "agent-payer-auth",
      now: NOW,
      alibi: ref,
    });
    const forged = { ...genuine, request, directory: { keys: [attacker.jwk] } };
    const r = await verifyExport(forged, {
      now: NOW,
      issuerKeys: [],
      receiptKeys: RECEIPT_KEYS,
      agentKeys: [agentHttp.jwk],
    });
    expect(failedOf(r)).toContain("signatures");
    const ok = await verifyExport(genuine, {
      now: NOW,
      issuerKeys: [],
      receiptKeys: RECEIPT_KEYS,
      agentKeys: [agentHttp.jwk],
    });
    expect(failedOf(ok)).toEqual([]);
  });

  test("a payer request for a refused purchase does not verify", async () => {
    const agentHttp = await httpKey();
    const denied = v2Ref("deny-2of2");
    const request = await signAgentRequest(
      { method: "GET", url: "https://runfast.example/" },
      agentHttp,
      {
        tag: "agent-payer-auth",
        now: NOW,
        alibi: denied,
      },
    );
    const x = {
      type: "keelson.tap/1",
      request,
      directory: { keys: [agentHttp.jwk] },
      alibi: denied,
    };
    const r = await verifyExport(x, {
      now: NOW,
      issuerKeys: [],
      receiptKeys: RECEIPT_KEYS,
      agentKeys: [agentHttp.jwk],
    });
    expect(failedOf(r)).toContain("facts");
  });
});

describe("AP2 verification reads only disclosures the issuer signed", () => {
  async function closed() {
    const issuer = await testIssuer(ALLOW_PAYPAL);
    const agent = await testAgent();
    const x = await exportAp2(factsFor(ALLOW_PAYPAL, agent), ref, { issuer, agent }, { now: NOW });
    return { issuer, agent, x };
  }

  test("open mandates re-pointed at an attacker's key by swapping disclosures fail", async () => {
    const issuer = await testIssuer(ALLOW_PAYPAL);
    const x = await exportAp2(purchaseFacts(alibi(ALLOW_PAYPAL)), ref, { issuer }, { now: NOW });
    const attacker = await testAgent();
    const swap = (token: string, edit: (v: Record<string, unknown>) => Record<string, unknown>) => {
      const [jwt, disclosure] = token.split("~") as [string, string];
      const [salt, value] = JSON.parse(Buffer.from(disclosure, "base64url").toString());
      return `${jwt}~${Buffer.from(JSON.stringify([salt, edit(value)])).toString("base64url")}~`;
    };
    const checkout = swap(x.checkout.open, (v) => ({ ...v, cnf: { jwk: attacker.jwk } }));
    const payment = swap(x.payment.open, (v) => ({
      ...v,
      cnf: { jwk: attacker.jwk },
      constraints: (v.constraints as { type: string }[]).map((c) =>
        c.type === "payment.reference" ? { ...c, conditional_transaction_id: sdHash(checkout) } : c,
      ),
    }));
    const forged = await closeAp2(
      {
        ...x,
        checkout: { ...x.checkout, open: checkout },
        payment: { ...x.payment, open: payment },
      },
      attacker,
      { now: NOW },
    );
    expect(failedOf(await verifyAp2(forged, { now: NOW, issuerKeys: [issuer.jwk] }))).toContain(
      "chain_binding",
    );
  });

  test("one closed chain without the other fails", async () => {
    const { issuer, x } = await closed();
    const { closed: _, receipt: __, ...payment } = x.payment;
    const forged: Ap2Export = { ...x, payment };
    expect(failedOf(await verifyAp2(forged, { now: NOW, issuerKeys: [issuer.jwk] }))).toContain(
      "chain_binding",
    );
  });

  test("a refused purchase closes no payment mandate, in AP2 or VI", async () => {
    const issuer = await testIssuer(DENY_PAYPAL);
    const agent = await testAgent();
    const f = factsFor(DENY_PAYPAL, agent);
    const ap2 = await exportAp2(f, refFor(DENY_PAYPAL), { issuer, agent }, { now: NOW });
    expect(ap2.payment.closed).toBeUndefined();
    expect(ap2.checkout.closed).toBeDefined();
    const vi = (await exportVi(
      f,
      refFor(DENY_PAYPAL),
      { issuer, agent },
      { now: NOW },
    )) as ViExport;
    expect(vi.l3_payment).toBeUndefined();
  });
});

test("an ACP allowance for a refused purchase does not verify, even signed by the issuer", async () => {
  const issuer = await testIssuer(ALLOW_PAYPAL);
  const x = (await exportAcp(
    purchaseFacts(alibi(ALLOW_PAYPAL)),
    ref,
    { issuer },
    { now: NOW },
  )) as AcpExport;
  const p = jwtPayload(x.attestation) as { keelson: { facts: Record<string, unknown> } };
  const forged = {
    ...p,
    keelson: { ...p.keelson, facts: { ...p.keelson.facts, decision: "deny" } },
  };
  const attestation = await new SignJWT(forged)
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: issuer.jwk.kid })
    .sign((issuer as unknown as { privateKey: CryptoKey }).privateKey);
  expect(
    failedOf(await verifyAcp({ ...x, attestation }, { now: NOW, issuerKeys: [issuer.jwk] })),
  ).toContain("facts");
});

test("a VI export whose checkout JWT belongs to another purchase fails the facts", async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  const paypal = await localExportSigner(jwk, () =>
    statementFacts(purchaseFacts(alibi(ALLOW_PAYPAL))),
  );
  const card = await localExportSigner(jwk, () => statementFacts(purchaseFacts(alibi(ALLOW_CARD))));
  const vi = (await exportVi(
    purchaseFacts(alibi(ALLOW_PAYPAL)),
    ref,
    { issuer: paypal },
    { now: NOW },
  )) as ViExport;
  const other = await exportAp2(
    purchaseFacts(alibi(ALLOW_CARD)),
    refFor(ALLOW_CARD),
    { issuer: card },
    { now: NOW },
  );
  const pending = vi.pending_close as NonNullable<ViExport["pending_close"]>;
  const forged = {
    ...vi,
    pending_close: {
      ...pending,
      checkout: { ...pending.checkout, checkout_jwt: other.checkout.checkout_jwt },
    },
  };
  const r = await verifyExport(forged, {
    now: NOW,
    issuerKeys: [paypal.jwk],
    receiptKeys: RECEIPT_KEYS,
  });
  expect(failedOf(r)).toContain("facts");
});

test("a malformed export is a failed report, not a crash", async () => {
  const r = await verifyExport(
    {
      type: "keelson.ap2/1",
      alibi: ref,
      checkout: { open: "x", checkout_jwt: "y" },
      payment: { open: "z" },
    },
    { now: NOW, issuerKeys: [], receiptKeys: RECEIPT_KEYS },
  );
  expect(r.ok).toBe(false);
});

describe("purchases a format cannot state are refused with a reason", () => {
  test("an unknown currency", () => {
    const b = alibi(ALLOW_PAYPAL);
    const odd = { ...b, tee: { ...b.tee, countersign: { ...b.tee.countersign, currency: "999" } } };
    expect(() => purchaseFacts(odd)).toThrow(
      expect.objectContaining({ reason: "unsupported_currency" }),
    );
  });

  test("a v2 Alibi whose statement is not a purchase", () => {
    expect(() => purchaseFacts(v2Of(ALLOW_PAYPAL, "card-auth-approve"))).toThrow(
      expect.objectContaining({ reason: "not_a_purchase" }),
    );
  });

  test.each(["ap2", "vi", "ucp", "acp"] as const)("%s without a known payee", async (format) => {
    const f = { ...purchaseFacts(alibi(ALLOW_CARD)), payee: "" };
    const agent = await testAgent();
    const issuer = await testIssuer(ALLOW_CARD);
    await expect(
      exportOne(
        format,
        { ...f, mandate: factsFor(ALLOW_CARD, agent).mandate },
        refFor(ALLOW_CARD),
        { issuer, agent },
        {
          now: NOW,
          bundle: alibi(ALLOW_CARD),
        },
      ),
    ).rejects.toMatchObject({ reason: "no_payee" });
  });
});
