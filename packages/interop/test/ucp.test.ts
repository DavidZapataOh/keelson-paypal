import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { jwtPayload } from "../src/jose.ts";
import { ExportRefused } from "../src/signer.ts";
import {
  exportUcp,
  MerchantAuthorizationError,
  signMerchantAuthorization,
  UCP_VERSION,
  verifyMerchantAuthorization,
  verifyUcp,
} from "../src/ucp.ts";
import {
  ALLOW_CARD,
  ALLOW_PAYPAL,
  factsFor,
  NOW,
  refFor,
  testAgent,
  testIssuer,
} from "./fixtures.ts";
import { errors } from "./schemas.ts";

const CHECKOUT = "https://ucp.dev/schemas/shopping/checkout.json";

async function exported(id: string) {
  const issuer = await testIssuer(id);
  const agent = await testAgent();
  return {
    issuer,
    x: await exportUcp(factsFor(id, agent), refFor(id), { issuer, agent }, { now: NOW }),
  };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof MerchantAuthorizationError) return e.code;
    throw e;
  }
  return undefined;
};

describe("UCP 2026-08-25 checkout", () => {
  test("an Alibi without its cart cannot state UCP's required subtotal, so it is not exported", async () => {
    await expect(exported(ALLOW_PAYPAL)).rejects.toEqual(new ExportRefused("no_cart"));
  });

  test("validates against UCP's checkout schema", async () => {
    const { x } = await exported(ALLOW_CARD);
    expect(x.version).toBe(UCP_VERSION);
    expect(errors(CHECKOUT, x.checkout)).toEqual([]);
  });

  test("carries the statement as a reverse-domain signal", async () => {
    const { x } = await exported(ALLOW_CARD);
    expect((x.checkout.signals as Record<string, string>)["finance.keelson.alibi"]).toBe(
      refFor(ALLOW_CARD).statement,
    );
  });

  test("completes with the closed AP2 checkout mandate, and verifies", async () => {
    const { x, issuer } = await exported(ALLOW_CARD);
    expect(x.complete_request.ap2.checkout_mandate).toContain("~~");
    expect(jwtPayload(x.attestation).checkout).toEqual(x.checkout);
    expect((await verifyUcp(x, { now: NOW, issuerKeys: [issuer.jwk] })).ok).toBe(true);
  });

  test("refuses the placeholder mandate UCP's own conformance test accepts", async () => {
    const { x, issuer } = await exported(ALLOW_CARD);
    const placeholder = {
      ...x,
      complete_request: { ap2: { checkout_mandate: "header.payload.signature~kb_signature" } },
    };
    const r = await verifyUcp(placeholder, { now: NOW, issuerKeys: [issuer.jwk] });
    expect(r.checks.filter((c) => !c.ok).map((c) => c.id)).toContain("chain_binding");
  });

  test("UCP's checkout_mandate pattern, published or as proposed, cannot match an AP2 chain", async () => {
    const { x } = await exported(ALLOW_CARD);
    const schema = JSON.parse(
      readFileSync(
        new URL("../vendor/ucp/common/payment_ap2_mandate.json", import.meta.url),
        "utf8",
      ),
    );
    const published = new RegExp(schema.$defs.checkout_mandate.pattern);
    // Universal-Commerce-Protocol/ucp#610, the open fix for #599.
    const proposed = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+(~[A-Za-z0-9_-]*)*$/;
    expect(published.test(x.complete_request.ap2.checkout_mandate)).toBe(false);
    expect(proposed.test(x.complete_request.ap2.checkout_mandate)).toBe(false);
  });
});

describe("merchant authorization (RFC 7515 Appendix F over RFC 8785)", () => {
  test("signs and verifies a checkout; any change breaks it", async () => {
    const merchant = await testAgent();
    const { x } = await exported(ALLOW_CARD);
    const ap2 = { merchant_authorization: await signMerchantAuthorization(x.checkout, merchant) };
    const signed = { ...x.checkout, ap2 };
    await expect(
      verifyMerchantAuthorization(signed, { keys: [merchant.jwk] }),
    ).resolves.toBeUndefined();
    expect(
      await codeOf(
        verifyMerchantAuthorization({ ...signed, currency: "EUR" }, { keys: [merchant.jwk] }),
      ),
    ).toBe("signature");
    const [h, , s] = ap2.merchant_authorization.split(".");
    const attached = { ...x.checkout, ap2: { merchant_authorization: `${h}.e30.${s}` } };
    expect(await codeOf(verifyMerchantAuthorization(attached, { keys: [merchant.jwk] }))).toBe(
      "not_detached",
    );
  });
});
