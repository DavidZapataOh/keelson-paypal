import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { chosenStatement, statementAsk, supportsStatements } from "../src/tee/statements.ts";

const oldHealth = JSON.parse(
  readFileSync(new URL("./fixtures/health-b-62dcd607.json", import.meta.url), "utf8"),
);
const newHealth = { ...oldHealth, statements: 1 };
const m = {
  tdx: `0x${"11".repeat(32)}`,
  nitro: `0x${"22".repeat(32)}`,
} as const;
const salt = `0x${"33".repeat(32)}` as const;
const legA = {
  signer: "0x97f189c52006a6adba207d9a29550111f5de02ca",
  signature: `0x${"aa".repeat(65)}`,
} as const;

describe("SCITT statements from the legs", () => {
  test("a leg on today's engine does not sign statements; one that says so does", () => {
    expect(supportsStatements(oldHealth)).toBe(false);
    expect(supportsStatements(newHealth)).toBe(true);
    expect(supportsStatements({ ...oldHealth, statements: 2 })).toBe(false);
  });

  test("leg A is asked with the measurements and, for PayPal, the ref salt", () => {
    expect(statementAsk({ supports: true, measurements: m, refSalt: salt })).toEqual({
      measurements: m,
      ref_salt: salt,
    });
    expect(statementAsk({ supports: true, measurements: { tdx: m.tdx, nitro: null } })).toEqual({
      measurements: { tdx: m.tdx },
    });
  });

  test("a leg on the old engine is never sent the field", () => {
    expect(statementAsk({ supports: false, measurements: m, refSalt: salt })).toBeUndefined();
  });

  test("leg B is asked only when leg A signed a statement and B signs them", () => {
    expect(statementAsk({ supports: true, measurements: m, refSalt: salt, legA })).toEqual({
      measurements: m,
      ref_salt: salt,
      leg_a: legA,
    });
  });

  test("the statement kept is leg B's in 2of2, leg A's when degraded, none across engines", () => {
    expect(chosenStatement("2of2", "QQ==", "Qg==")).toBe("Qg==");
    expect(chosenStatement("degraded", "QQ==", undefined)).toBe("QQ==");
    expect(chosenStatement("2of2", "QQ==", undefined)).toBeNull();
    expect(chosenStatement("2of2", undefined, undefined)).toBeNull();
  });
});
