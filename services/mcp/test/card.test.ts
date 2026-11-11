import { describe, expect, test } from "vitest";
import { fixtures } from "../../../packages/alibi/test/fixtures.ts";
import { v2Bundle, vector } from "../../../packages/alibi/test/v2.ts";
import { cardOf } from "../src/server.ts";

const purchase = (id: string) => ({
  id,
  state: "CAPTURED",
  amount: { currency: "USD", minor: "100" },
  mode: "2of2" as const,
  logIndex: "7",
  capture: null,
  failure: null,
});

describe("the Alibi card", () => {
  test("a v2 Alibi is a SCITT statement, served at its .cose url, issued at its CWT iat", () => {
    const b = v2Bundle();
    const card = cardOf(purchase(b.alibi_id) as never, b);
    expect(card.envelope).toBe("scitt");
    expect(card.statementUrl).toBe(`https://api.keelson.finance/v1/alibis/${b.alibi_id}.cose`);
    const iat = Number(vector("allow-2of2").inputs.countersign.issuedAt);
    expect(card.issuedAt).toBe(new Date(iat * 1000).toISOString().replace(".000Z", "Z"));
    expect(card.verifyUrl).not.toBeNull();
  });

  test("a v1 Alibi's card is as before, with the v1 envelope and no statement", () => {
    const f = fixtures[0];
    if (!f) throw new Error("no fixture");
    const card = cardOf(purchase(f.id) as never, f.bundle);
    expect(card.envelope).toBe("v1");
    expect(card.statementUrl).toBeNull();
    expect(card.issuedAt).toBe(f.bundle.leaf_view.issued_at);
    expect(card.timestamps).toBe(f.bundle.timestamps.length);
  });

  test("no Alibi yet: no envelope", () => {
    expect(cardOf(purchase("01M725SRGK6SS7HEXN1K572KJY") as never, null).envelope).toBeNull();
  });
});
