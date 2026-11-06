import { describe, expect, it } from "vitest";
import { CATEGORY_LABELS, prepareSigning, renderCard } from "../src/card.ts";
import { hSd, mandateChallenge } from "../src/challenge.ts";
import type { Evidence } from "../src/colors.ts";
import { mandateCommitment } from "../src/commitment.ts";
import { CATEGORY_TABLE, type Mandate, parseMandate } from "../src/schema.ts";
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
    expect(row("total")).toMatchObject({
      label: "Maximum total",
      values: ["100.00 USD"],
      color: "green",
      answers: "Keelson",
    });
    expect(row("variant")).toMatchObject({ color: "amber", answers: "Agent operator" });
    expect(row("variant")?.values).toEqual(["size_us: 10", "color: any"]);
    expect(row("subjective")).toMatchObject({
      values: ["look good"],
      color: "gray",
      answers: "You",
    });
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

describe("card contents", () => {
  const card = async (m: Mandate = mandate()) => {
    const { payloadSd, disclosures } = await buildSdPayload(m, randomSalt);
    const c = renderCard(payloadSd, disclosures, evidence);
    return (field: string) => c.rows.find((r) => r.field === field);
  };

  it("keeps list entries separate and shows what the engine binds", async () => {
    const m = mandate();
    for (const c of m.checkout.constraints) {
      if (c.type === "keelson.attributes") c.must = { size_us: "10, color: red" };
    }
    const row = await card(m);
    expect(row("variant")?.values).toEqual(["size_us: 10, color: red"]);
    expect(row("merchant")?.values).toEqual(["RunFast (runfast.example, PayPal MERCH7XK2Q9LD)"]);
  });

  it("names categories, formats the bond and shows the mode", async () => {
    const row = await card();
    expect(row("category")?.values).toEqual(["Apparel & Accessories > Shoes"]);
    expect(row("bond")?.values).toEqual(["0.005000 PYUSD"]);
    expect(row("mode")?.values[0]).toMatch(/^Autonomous/);
    expect(row("recurrence")?.values).toEqual(["Not acknowledged"]);
  });

  it("shows any item with its title", async () => {
    const m = mandate();
    for (const c of m.checkout.constraints) {
      if (c.type === "checkout.line_items") {
        c.items.push({
          id: "l2",
          acceptable_items: [{ id: "*", title: "Trail shoes" }],
          quantity: 1,
        });
        c.items.splice(0, 1);
      }
    }
    const { payloadSd, disclosures } = await buildSdPayload(m, randomSalt);
    const c = renderCard(payloadSd, disclosures, evidence);
    expect(c.rows.find((r) => r.field === "items")).toMatchObject({
      values: ['Any item ("Trail shoes")'],
      color: "gray",
      answers: "You",
    });
    expect(c.rows.find((r) => r.field === "quantity")?.values).toEqual(["1"]);
    expect(c.warnings).toContain(
      "The item title is a description; any item in the allowed categories matches.",
    );
  });

  it("labels every category in the table", () => {
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual([...CATEGORY_TABLE.ids].sort());
  });

  it("refuses text that could hide or reorder what the user reads", async () => {
    for (const name of ["Run\u202eFast", "Run\nFast", "Run\u200bFast", "Run\ufeffFast"]) {
      const m = mandate();
      for (const c of m.checkout.constraints) {
        if (c.type === "checkout.allowed_merchants") for (const x of c.allowed) x.name = name;
      }
      await expect(prepareSigning(m, randomSalt(), evidence)).rejects.toThrow(/control or format/);
    }
  });
});

describe("prepareSigning", () => {
  it("binds C_m into the signed payload and the challenge", async () => {
    const salt = randomSalt();
    const m = mandate();
    const s = await prepareSigning(m, salt, evidence);
    const cm = await mandateCommitment(m, salt);
    expect(s.cm).toBe(cm);
    const decoded = decodeMandate(s.payloadSd, s.disclosures);
    expect(decoded.zk.commitment).toBe(`0x${cm.toString(16).padStart(64, "0")}`);
    expect(decoded.zk.commitment).not.toBe(m.zk.commitment);
    expect(s.commitment).toBe(decoded.zk.commitment);
    expect(s.hSd).toEqual(hSd(s.payloadSd));
    expect(s.challenge).toEqual(mandateChallenge(hSd(s.payloadSd), s.cm));
    expect(s.card.rows.length).toBeGreaterThan(0);
  });

  it("derives the payment confirmation details from the mandate", async () => {
    const s = await prepareSigning(mandate(), randomSalt(), evidence);
    expect(s.spc).toEqual({
      payeeName: "Keelson",
      payeeOrigin: "https://keelson.finance",
      total: { currency: "USD", value: "100.00" },
    });
  });
});
