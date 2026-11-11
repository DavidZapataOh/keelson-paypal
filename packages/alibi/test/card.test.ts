import { describe, expect, test } from "vitest";
import type { AlibiBundle } from "../src/schema.ts";
import { verifyAlibi } from "../src/verify/index.ts";
import { copy, fixtures } from "./fixtures.ts";

const [fixture] = fixtures;
if (!fixture) throw new Error("no Alibi fixture");

const statusOf = async (b: AlibiBundle) =>
  (await verifyAlibi(b, { chain: null })).checks.find((c) => c.id === "card.authorizations");

const card: NonNullable<AlibiBundle["card"]> = {
  issuer: "lithic",
  card_token: "card",
  last_four: "4242",
  ref_salt: `0x${"11".repeat(32)}`,
  controls: {},
  authorizations: [],
};

describe("the card check", () => {
  test("a PayPal purchase has no card section", async () => {
    expect((await statusOf(fixture.bundle))?.status).toBe("absent");
  });

  test("a card section must open the leaf's payment commitment, and stand alone", async () => {
    const both = { ...copy(fixture.bundle), card };
    expect((await statusOf(both))?.status).toBe("fail");
    const { paypal: _, ...rest } = copy(fixture.bundle);
    const forged = { ...rest, card } as AlibiBundle;
    const check = await statusOf(forged);
    expect(check?.status).toBe("fail");
    expect(check?.reason).toMatch(/payment commitment/);
  });
});
