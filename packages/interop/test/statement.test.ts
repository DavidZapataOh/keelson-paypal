import { base64url } from "jose";
import { describe, expect, test } from "vitest";
import { purchaseFacts, statementFacts } from "../src/facts.ts";
import { StatementError, verifyStatement } from "../src/statement.ts";
import { ALLOW_PAYPAL, alibi } from "./fixtures.ts";
import { RECEIPT_KEYS, v2Ref } from "./v2.ts";

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof StatementError) return e.code;
    throw e;
  }
  return undefined;
};

const flip = (b64: string, at: number) => {
  const bytes = base64url.decode(b64);
  bytes[at] = (bytes[at] as number) ^ 1;
  return base64url.encode(bytes);
};

describe("verifyStatement", () => {
  test("a Transparent Statement yields the countersigned facts the Alibi carries", () => {
    expect(verifyStatement(v2Ref("allow-2of2"), { receiptKeys: RECEIPT_KEYS })).toEqual(
      statementFacts(purchaseFacts(alibi(ALLOW_PAYPAL))),
    );
  });

  test("a v1 Alibi's bridge statement yields the same countersigned facts", () => {
    expect(verifyStatement(v2Ref("bridge-2of2"), { receiptKeys: RECEIPT_KEYS })).toEqual(
      statementFacts(purchaseFacts(alibi(ALLOW_PAYPAL))),
    );
  });

  test("an unknown receipt key fails the receipt", () => {
    expect(codeOf(() => verifyStatement(v2Ref("allow-2of2"), { receiptKeys: new Map() }))).toBe(
      "receipt",
    );
  });

  test("a flipped statement signature byte fails the statement", () => {
    const ref = v2Ref("allow-2of2");
    const bytes = base64url.decode(ref.statement);
    // COSE_Sign1 ends with its signature.
    const at = bytes.length - 1;
    expect(
      codeOf(() =>
        verifyStatement(
          { ...ref, statement: flip(ref.statement, at) },
          { receiptKeys: RECEIPT_KEYS },
        ),
      ),
    ).toBe("statement");
  });

  test("a leaf hash that is not the statement's fails the statement", () => {
    const ref = v2Ref("allow-2of2");
    expect(
      codeOf(() =>
        verifyStatement(
          { ...ref, leafHash: v2Ref("deny-2of2").leafHash },
          { receiptKeys: RECEIPT_KEYS },
        ),
      ),
    ).toBe("statement");
  });
});
