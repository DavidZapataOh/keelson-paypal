import { describe, expect, test } from "vitest";
import { renderCard } from "../src/card.ts";
import { MCC_TABLE, onCardRail, storesFor } from "../src/mcc.ts";
import { parseMandate } from "../src/schema.ts";
import { buildSdPayload } from "../src/sd.ts";
import demo from "./fixtures/demo-mandate.json" with { type: "json" };

const NO_EVIDENCE = { merchantSignedCheckout: false, zkTlsFields: new Set<never>() };

describe("the card rail", () => {
  test("every code has a name", () => {
    expect(Object.keys(MCC_TABLE.labels).sort()).toEqual([...MCC_TABLE.codes].sort());
  });

  test("names the stores a category is sold at, and general stores otherwise", () => {
    expect(storesFor(["gpt:412"])).toContain("5814");
    expect(storesFor(["gpt:187", "gpt:166"])).toEqual(
      expect.arrayContaining(["5661", "5651", "5311"]),
    );
    expect(storesFor([])).toEqual(["5311", "5310", "5999"]);
    for (const code of storesFor(["gpt:1", "gpt:222", "gpt:412", "gpt:2092"])) {
      expect(MCC_TABLE.codes).toContain(code);
    }
  });

  test("turns a PayPal mandate into a valid card mandate the card shows", async () => {
    const m = onCardRail(parseMandate(structuredClone(demo)), ["5814", "5499"]);
    expect(parseMandate(m).payment.rail).toBe("card");
    const { payloadSd, disclosures } = await buildSdPayload(m, () =>
      crypto.getRandomValues(new Uint8Array(16)),
    );
    const card = renderCard(payloadSd, disclosures, NO_EVIDENCE);
    const row = (f: string) => card.rows.find((r) => r.field === f);
    expect(row("merchant")?.values).toEqual([
      "Any store · card (US: Fast food restaurants 5814, Food stores and coffee shops 5499)",
    ]);
    expect(row("card")?.color).toBe("green");
  });
});
