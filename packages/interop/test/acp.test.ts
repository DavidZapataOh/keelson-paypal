import { describe, expect, test } from "vitest";
import { ACP_MAX_TTL_SECONDS, exportAcp, verifyAcp } from "../src/acp.ts";
import { purchaseFacts } from "../src/facts.ts";
import { jwtPayload } from "../src/jose.ts";
import { ExportRefused } from "../src/signer.ts";
import {
  ALLOW_CARD,
  ALLOW_PAYPAL,
  alibi,
  DENY_PAYPAL,
  NOW,
  refFor,
  testIssuer,
} from "./fixtures.ts";
import { errors } from "./schemas.ts";

const ALLOWANCE =
  "https://example.com/schemas/delegate-payment/bundle.schema.json#/$defs/Allowance";

const exported = async (id: string) => {
  const issuer = await testIssuer(id);
  return {
    issuer,
    x: await exportAcp(purchaseFacts(alibi(id)), refFor(id), { issuer }, { now: NOW }),
  };
};

describe("ACP 2026-04-17 delegated payment allowance", () => {
  test.each([ALLOW_PAYPAL, ALLOW_CARD])("%s validates against the ACP schema", async (id) => {
    const { x } = await exported(id);
    expect(errors(ALLOWANCE, x.allowance)).toEqual([]);
  });

  test("lower-case currency, a cap that covers the purchase, a short life", async () => {
    const { x } = await exported(ALLOW_PAYPAL);
    const f = purchaseFacts(alibi(ALLOW_PAYPAL));
    expect(x.allowance).toMatchObject({
      reason: "one_time",
      currency: "usd",
      max_amount: 10000,
      merchant_id: "A4WCRYD5EYDF2",
      checkout_session_id: "8MY937060S1606416",
    });
    expect(x.allowance.max_amount).toBeGreaterThanOrEqual(f.totalMinor);
    expect(Date.parse(x.allowance.expires_at) / 1000).toBeLessThanOrEqual(
      f.issuedAt + ACP_MAX_TTL_SECONDS,
    );
  });

  test("names the statement by URI and hash, in string metadata", async () => {
    const { x } = await exported(ALLOW_PAYPAL);
    const ref = refFor(ALLOW_PAYPAL);
    expect(x.metadata.keelson_alibi_uri).toBe(ref.uri);
    expect(x.metadata.keelson_alibi_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.values(x.metadata).every((v) => typeof v === "string")).toBe(true);
  });

  test("the attestation is issued over the allowance and bound to the statement's currency", async () => {
    const { x, issuer } = await exported(ALLOW_PAYPAL);
    expect(jwtPayload(x.attestation)).toMatchObject({
      allowance: x.allowance,
      metadata: x.metadata,
    });
    expect((await verifyAcp(x, { now: NOW, issuerKeys: [issuer.jwk] })).ok).toBe(true);
  });

  test("a cap below the purchase fails verification", async () => {
    const { x, issuer } = await exported(ALLOW_PAYPAL);
    const r = await verifyAcp(
      { ...x, allowance: { ...x.allowance, max_amount: 1 } },
      { now: NOW, issuerKeys: [issuer.jwk] },
    );
    expect(r.checks.filter((c) => !c.ok).map((c) => c.id)).toContain("facts");
  });

  test("a refused cart gets no allowance", async () => {
    await expect(exported(DENY_PAYPAL)).rejects.toEqual(new ExportRefused("denied"));
  });
});
