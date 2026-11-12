import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  type AmountCheck,
  amountConfirmChallenge,
  buildSdPayload,
  orderIdHash,
  parseMandate,
} from "@keelson/mandate";
import { describe, expect, test } from "vitest";
import demo from "../../mandate/test/fixtures/demo-mandate.json" with { type: "json" };
import type { AlibiBundle } from "../src/schema.ts";
import { runCheck } from "../src/verify/check.ts";
import { amountAuthority } from "../src/verify/checks/amount.ts";

const ALIBI = "01M777FEC6WWKNJKJRVZ5C3T8B";
const ORDER = "3PW02531015001930";
const PAYEE = "DZ93UDZC2BKLE";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" }) as {
  kty: string;
  crv: string;
  x: string;
  y: string;
};
const CRED = "Y3JlZGVudGlhbC0x";

/** A passkey assertion over `challenge`, made in the Keelson app with user verification. */
function assert(challenge: Uint8Array, origin = "https://app.keelson.finance") {
  const authenticatorData = Buffer.concat([
    createHash("sha256").update("keelson.finance").digest(),
    Buffer.from([0x05]),
    Buffer.from([0, 0, 0, 1]),
  ]);
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: Buffer.from(challenge).toString("base64url"),
      origin,
      crossOrigin: false,
    }),
  );
  const signature = sign(
    "sha256",
    Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]),
    { key: privateKey, dsaEncoding: "der" },
  );
  return {
    credentialId: CRED,
    authenticatorData: authenticatorData.toString("base64url"),
    clientDataJSON: clientDataJSON.toString("base64url"),
    signature: signature.toString("base64url"),
  };
}

const sd = await buildSdPayload(
  parseMandate({
    ...demo,
    user: { ...demo.user, cred: { id: CRED, rp_id: "keelson.finance", jwk } },
  }),
  () => crypto.getRandomValues(new Uint8Array(16)),
);

const confirmed = (o: Partial<AmountCheck> = {}): AmountCheck => {
  const base: AmountCheck = {
    v: "keelson.amount_check/1",
    authority: "user_confirmed",
    read_by: "api",
    order_id_hash: orderIdHash(ORDER),
    total: { currency: "USD", minor: 295 },
    payee: PAYEE,
    intent: "CAPTURE",
    checked_at: "2026-11-12T08:00:00.000Z",
    cross_check: "agrees",
  };
  const c = { ...base, ...o };
  return {
    ...c,
    evidence: {
      assertion: assert(
        amountConfirmChallenge({
          purchase_id: ALIBI,
          order_id_hash: base.order_id_hash,
          currency: base.total.currency,
          minor: base.total.minor,
          payee: base.payee,
        }),
      ),
    },
  };
};

const bundle = (a: AmountCheck | undefined, amount = "295") =>
  ({
    type: "application/vnd.keelson.alibi.v1+json",
    alibi_id: ALIBI,
    tee: { countersign: { amount, currency: "840" } },
    mandate: { payload_sd: sd.payloadSd, disclosures: sd.disclosures },
    paypal: {
      order_id: "6XX99734C4618040C",
      authorization_id: "2YE949500W649811X",
      custom_id: "x",
      ref_salt: `0x${"00".repeat(32)}`,
      ...(a ? { amount_authority: a } : {}),
    },
  }) as unknown as AlibiBundle;

const run = (b: AlibiBundle) =>
  runCheck(amountAuthority, b, {
    now: new Date(),
    expect: undefined,
    chain: null,
    view: null,
    receiptKeys: new Map(),
  });

describe("an Alibi's amount authority", () => {
  test("a user's passkey confirmation verifies offline with the mandate's passkey", async () => {
    const c = await run(bundle(confirmed()));
    expect(c.status, c.reason).toBe("pass");
    expect(c.detail).toEqual({
      authority: "user_confirmed",
      read_by: "api",
      cross_check: "agrees",
    });
  });

  test("an edited amount, payee or order fails", async () => {
    for (const edit of [
      { total: { currency: "USD", minor: 296 } },
      { payee: "OTHERPAYEE0001" },
      { order_id_hash: orderIdHash("1AB23456CD7890123") },
    ] as const) {
      const c = await run(bundle(confirmed(edit), String(edit.total?.minor ?? 295)));
      expect(c.status, JSON.stringify(edit)).toBe("fail");
    }
    expect((await run(bundle(confirmed(), "300"))).reason).toMatch(/another amount/);
  });

  test("an assertion from another origin, or another passkey, fails", async () => {
    const elsewhere = confirmed();
    const evidence = elsewhere.evidence?.assertion;
    if (!evidence) throw new Error("no assertion");
    const other = {
      ...elsewhere,
      evidence: {
        assertion: {
          ...assert(new Uint8Array(32), "https://evil.example"),
        },
      },
    };
    expect((await run(bundle(other))).status).toBe("fail");
    const stranger = {
      ...elsewhere,
      evidence: { assertion: { ...evidence, credentialId: "b3RoZXI" } },
    };
    expect((await run(bundle(stranger))).reason).toMatch(/passkey the mandate names/);
  });

  test("PayPal's Orders API passes as read by the API; the checkout page alone stays pending", async () => {
    const order: AmountCheck = { ...confirmed(), authority: "paypal_order", via: "own" };
    delete order.evidence;
    expect((await run(bundle(order))).detail).toEqual({
      authority: "paypal_order",
      via: "own",
      read_by: "api",
      cross_check: "agrees",
    });
    const page = await run(bundle({ ...order, authority: "checkout_page" }));
    expect(page.status).toBe("pending");
    expect(page.reason).toMatch(/checkout page only, not confirmed/);
  });

  test("an Alibi recorded without one is not applicable", async () => {
    expect((await run(bundle(undefined))).status).toBe("absent");
  });
});
