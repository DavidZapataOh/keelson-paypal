import { readFileSync } from "node:fs";
import { decodeDisclosed } from "@keelson/mandate";
import { describe, expect, test } from "vitest";
import { valueAt } from "../src/bindings.ts";
import { purchaseFacts, statementFacts } from "../src/facts.ts";
import {
  type EvidencePack,
  evidencePack,
  PACK_TYPE,
  RULES_EDITION,
  verifyEvidencePack,
} from "../src/visa.ts";
import {
  ALLOW_CARD,
  ALLOW_PAYPAL,
  alibi,
  DENY_PAYPAL,
  NOW,
  refFor,
  testIssuer,
} from "./fixtures.ts";
import { ajv } from "./schemas.ts";

const schema = JSON.parse(
  readFileSync(new URL("../schemas/visa-evidence-pack.schema.json", import.meta.url), "utf8"),
);
const validate = ajv.compile(schema);

async function pack(id: string, shipping?: string) {
  const issuer = await testIssuer(id);
  const p = await evidencePack(
    purchaseFacts(alibi(id)),
    refFor(id),
    { issuer },
    {
      now: NOW,
      bundle: alibi(id),
      ...(shipping ? { shipping } : {}),
    },
  );
  return { issuer, p };
}

const element = (p: EvidencePack, name: string) => p.ce3.elements.find((e) => e.rule === name);
const requirement = (p: EvidencePack, rule: string) => p.requirements.find((r) => r.rule === rule);

describe("Visa agentic evidence pack", () => {
  test.each([ALLOW_PAYPAL, ALLOW_CARD, DENY_PAYPAL])(
    "%s validates against the published schema",
    async (id) => {
      const { p } = await pack(id);
      expect(validate(p), JSON.stringify(validate.errors)).toBe(true);
      expect(p).toMatchObject({ type: PACK_TYPE, rules: RULES_EDITION });
    },
  );

  test("every evidence pointer resolves to its value in the Alibi", async () => {
    for (const id of [ALLOW_PAYPAL, ALLOW_CARD, DENY_PAYPAL]) {
      const { p } = await pack(id);
      const b = alibi(id);
      const sources = {
        statement: statementFacts(purchaseFacts(b)),
        mandate: decodeDisclosed(b.mandate.payload_sd, b.mandate.disclosures),
        bundle: b,
      };
      for (const item of [...p.requirements, ...p.ce3.elements]) {
        for (const e of item.evidence)
          expect(valueAt(sources[e.source], e.pointer), `${id} ${e.pointer}`).toEqual(e.value);
      }
    }
  });

  test("the owner's copy evidences the login id; a short fingerprint is named, not counted", async () => {
    const { p } = await pack(ALLOW_PAYPAL, "1 Main St, Springfield, IL 62701, US");
    expect(element(p, "login_id")?.status).toBe("evidenced");
    expect(element(p, "ip_address")?.status).toBe("evidenced");
    expect(element(p, "device_fingerprint")).toMatchObject({ status: "not_evidenced" });
    expect(element(p, "device_fingerprint")?.statement).toContain("20");
    expect(element(p, "delivery_address")?.status).toBe("evidenced");
    expect(element(p, "prior_transactions")?.status).toBe("not_available");
  });

  test("a public copy withholds every personal element and carries none of it", async () => {
    const { p } = await pack(ALLOW_CARD);
    for (const name of ["login_id", "ip_address", "device_fingerprint"]) {
      expect(element(p, name)?.status).toBe("withheld");
    }
    expect(JSON.stringify(p)).not.toContain("203.0.113.7");
  });

  test("the order confirmation is kept 120 days; a refused cart says so", async () => {
    const { p } = await pack(ALLOW_CARD);
    const order = requirement(p, "4.1.23.8");
    expect(order?.status).toBe("evidenced");
    expect(Date.parse(p.retained_until) - Date.parse(p.transaction.countersigned_at)).toBe(
      120 * 86_400_000,
    );
    const deny = (await pack(DENY_PAYPAL)).p;
    expect(deny.transaction.decision).toBe("deny");
    expect(requirement(deny, "4.1.23.4")?.status).toBe("evidenced");
    expect(requirement(deny, "4.1.23.4")?.statement).toMatch(/refused/);
  });

  test("the issuer's attestation binds the pack; a changed amount fails", async () => {
    const { p, issuer } = await pack(ALLOW_PAYPAL);
    expect((await verifyEvidencePack(p, { now: NOW, issuerKeys: [issuer.jwk] })).ok).toBe(true);
    const forged = { ...p, transaction: { ...p.transaction, amount_minor: 1 } };
    const r = await verifyEvidencePack(forged, { now: NOW, issuerKeys: [issuer.jwk] });
    expect(r.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(
      expect.arrayContaining(["facts"]),
    );
  });
});
