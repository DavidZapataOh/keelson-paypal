import { describe, expect, it } from "vitest";
import { prepareSigning, renderCard } from "../src/card.ts";
import { mandateChallenge } from "../src/challenge.ts";
import type { Evidence } from "../src/colors.ts";
import { mandateCommitment } from "../src/commitment.ts";
import { type Mandate, parseMandate } from "../src/schema.ts";
import { buildSdPayload, decodeMandate } from "../src/sd.ts";
import demo from "./fixtures/demo-mandate.json" with { type: "json" };

const mandate = (): Mandate => parseMandate(structuredClone(demo));
const evidence: Evidence = { merchantSignedCheckout: true, zkTlsFields: new Set() };
const randomSalt = () => crypto.getRandomValues(new Uint8Array(16));

describe("renderCard", () => {
  it("shows what Keelson, the operator and the user answer for", async () => {
    const { payloadSd, disclosures } = await buildSdPayload(mandate(), randomSalt);
    const card = renderCard(payloadSd, disclosures, evidence);
    const row = (field: string) => card.rows.find((r) => r.field === field);
    expect(row("total")).toMatchObject({ value: "100.00 USD", color: "green", answers: "Keelson" });
    expect(row("variant")).toMatchObject({ color: "amber", answers: "Agent operator" });
    expect(row("variant")?.value).toContain("10");
    expect(row("subjective")).toMatchObject({ value: "look good", color: "gray", answers: "You" });
    expect(card.warnings).toHaveLength(1);
    expect(card.warnings[0]).toContain("look good");
  });

  it("turns amber fields green once zkTLS proves them", async () => {
    const { payloadSd, disclosures } = await buildSdPayload(mandate(), randomSalt);
    const proven: Evidence = {
      merchantSignedCheckout: true,
      zkTlsFields: new Set(["category", "variant", "return_policy"]),
    };
    const card = renderCard(payloadSd, disclosures, proven);
    expect(card.rows.find((r) => r.field === "variant")?.color).toBe("green");
  });

  it("rejects a swapped disclosure", async () => {
    const { payloadSd, disclosures } = await buildSdPayload(mandate(), randomSalt);
    const other = await buildSdPayload(mandate(), randomSalt);
    const swapped = [other.disclosures[0] as string, ...disclosures.slice(1)];
    expect(() => decodeMandate(payloadSd, swapped)).toThrow();
    expect(() => renderCard(payloadSd, swapped, evidence)).toThrow();
  });

  it("rejects a missing disclosure", async () => {
    const { payloadSd, disclosures } = await buildSdPayload(mandate(), randomSalt);
    expect(() => renderCard(payloadSd, disclosures.slice(1), evidence)).toThrow();
  });
});

describe("prepareSigning", () => {
  it("binds the challenge to the payload hash and the commitment", async () => {
    const salt = randomSalt();
    const s = await prepareSigning(mandate(), salt, evidence);
    expect(s.cm).toBe(await mandateCommitment(mandate(), salt));
    expect(s.challenge).toEqual(mandateChallenge(s.hSd, s.cm));
    expect(s.challenge).toHaveLength(32);
    expect(s.card.rows.length).toBeGreaterThan(0);
  });
});
