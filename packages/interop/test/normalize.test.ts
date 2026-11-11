import { describe, expect, it } from "vitest";
import { alibiMandate } from "../src/facts.ts";
import { normalize } from "../src/normalize.ts";
import { ALLOWED, alibi, DENIED } from "./fixtures.ts";

describe("normalize", () => {
  it("states the standard constraints and moves Keelson's own to notes", () => {
    const n = normalize(alibiMandate(alibi(ALLOWED)));
    expect(n).toMatchObject({
      currency: "USD",
      merchants: [{ id: "mrc_runfast", name: "RunFast", website: "https://runfast.example" }],
      payees: [{ id: "A4WCRYD5EYDF2", name: "RunFast", website: "https://runfast.example" }],
      lines: [
        {
          id: "l1",
          acceptable: [{ id: "sku-trail-10", title: "Trail running shoe" }],
          quantity: 1,
        },
      ],
      maxAmount: 10000,
      budget: 10000,
      notAfter: "2026-11-13T23:59:59Z",
    });
    expect(n.notes).toEqual([
      "keelson.category: only Apparel & Accessories > Shoes.",
      "keelson.attributes: color = any, size_us = 10.",
      "keelson.returns: at least 30 days to return, free.",
    ]);
  });

  it("never exports a merchant's PayPal id as a merchant field", () => {
    const n = normalize(alibiMandate(alibi(DENIED)));
    expect(n.merchants).toEqual([
      { id: "mrc_alfred", name: "Alfred Music", website: "https://www.alfred.com" },
    ]);
  });
});
