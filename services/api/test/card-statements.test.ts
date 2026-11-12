import { describe, expect, test } from "vitest";
import { cardStatementRequest, collectedMinor, signingLeg } from "../src/cards/statements.ts";

const verdict = (tee: number, signature: string) => ({
  authorization: { requestId: `0x${"01".repeat(32)}`, decision: "1" },
  chain_id: 421614,
  digest: `0x${"02".repeat(32)}`,
  signature,
  signer: "0x0000000000000000000000000000000000000001",
  tee,
});
const tdx = verdict(1, `0x${"aa".repeat(65)}`);
const nitro = verdict(2, `0x${"bb".repeat(65)}`);

describe("card statements", () => {
  test("leg B signs a decision both legs made, leg A one it made alone", () => {
    expect(signingLeg({ tdx, nitro })).toBe("b");
    expect(signingLeg({ tdx, nitro: null })).toBe("a");
    expect(signingLeg({ tdx: null, nitro })).toBeNull();
  });

  test("the request carries both signatures, the purchase leaf and the card", () => {
    expect(
      cardStatementRequest({
        verdicts: { tdx, nitro },
        measurements: { tdx: `0x${"11".repeat(32)}`, nitro: `0x${"22".repeat(32)}` },
        parent: `0x${"44".repeat(32)}`,
        issuer: "lithic",
        cardToken: "card_1",
        refSalt: `0x${"33".repeat(32)}`,
        chainId: 421614,
      }),
    ).toEqual({
      authorization: tdx.authorization,
      signatures: { tdx: tdx.signature, nitro: nitro.signature },
      measurements: { tdx: `0x${"11".repeat(32)}`, nitro: `0x${"22".repeat(32)}` },
      parent: `0x${"44".repeat(32)}`,
      issuer: "lithic",
      card_token: "card_1",
      ref_salt: `0x${"33".repeat(32)}`,
      chain_id: 421614,
    });
  });

  test("the hold is collected for the legs' signed amount, never above the approval", () => {
    expect(collectedMinor(9400n, 9400n, 9999)).toBe(9400n);
    expect(collectedMinor(9400n, 10_000n, 10_000)).toBe(9400n);
    expect(collectedMinor(9400n, 9000n, 9400)).toBe(9000n);
    // Without a signed settlement (legs that predate it), the issuer's word, capped as before.
    expect(collectedMinor(9400n, null, 9500)).toBe(9400n);
  });
});
