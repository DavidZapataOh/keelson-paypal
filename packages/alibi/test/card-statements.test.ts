import { decodeSign1, encodeSign1 } from "@keelson/scitt";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";
import { fromBase64, toBase64 } from "../src/b64.ts";
import type { AlibiBundleV2 } from "../src/schema.ts";
import { verifyAlibi } from "../src/verify/index.ts";
import { cardV2Bundle, receiptFor, receiptKeys, transparent, v2Bundle, vector } from "./v2.ts";

const now = new Date("2026-11-10T00:00:00Z");
const status = async (b: AlibiBundleV2, id = "card.statements") =>
  (await verifyAlibi(b, { now, receiptKeys })).checks.find((c) => c.id === id);

type Card = NonNullable<AlibiBundleV2["card"]> & {
  statements: string[];
  settlement: { raw: string; settled_minor: string };
};
const cardOf = (b: AlibiBundleV2) => b.card as Card;

describe("card statements", () => {
  // The first verification in the file loads the verifier, seconds on a shared runner.
  test("decisions and settlement verify, each linked to the purchase", {
    timeout: 30_000,
  }, async () => {
    const c = await status(cardV2Bundle());
    expect(c?.status, c?.reason).toBe("pass");
    expect((await status(cardV2Bundle(), "card.authorizations"))?.status).toBe("pass");
  });

  test("a PayPal purchase has none", async () => {
    expect((await status(v2Bundle()))?.status).toBe("absent");
  });

  test("a statement whose parent is another leaf", async () => {
    const b = cardV2Bundle();
    const other = vector("allow-2of2").statement_hex;
    const card = cardOf(b);
    // The purchase statement swapped for another purchase: every card statement now names a foreign parent.
    const swapped = {
      ...b,
      statement: toBase64(transparent(hexToBytes(other), [receiptFor(hexToBytes(other)).receipt])),
    };
    expect((await status({ ...swapped, card } as AlibiBundleV2))?.status).toBe("fail");
  });

  test("a settlement amount edited in the bundle", async () => {
    const b = cardV2Bundle();
    cardOf(b).settlement.settled_minor = "101";
    expect((await status(b))?.status).toBe("fail");
  });

  test("a decision without its statement", async () => {
    const b = cardV2Bundle();
    cardOf(b).statements = cardOf(b).statements.slice(1);
    expect((await status(b))?.status).toBe("fail");
  });

  test("a statement re-signed by an unregistered key", async () => {
    const b = cardV2Bundle();
    const s = decodeSign1(fromBase64(cardOf(b).statements[0] as string));
    const sig = s.signature.slice();
    sig[5] = (sig[5] as number) ^ 1;
    cardOf(b).statements[0] = toBase64(encodeSign1({ ...s, signature: sig }));
    expect((await status(b))?.status).toBe("fail");
  });

  test("a raw issuer response byte flipped", async () => {
    const b = cardV2Bundle();
    const raw = fromBase64(cardOf(b).settlement.raw);
    raw[0] = (raw[0] as number) ^ 1;
    cardOf(b).settlement.raw = toBase64(raw);
    expect((await status(b))?.status).toBe("fail");
  });
});
