import { expect, test } from "vitest";
import { type CheckoutResult, scoreCheckout } from "../src/checkout.ts";

const result = (id: string, cls: string, clicked: boolean): CheckoutResult => ({
  id,
  class: cls,
  technique: "t",
  source: "s",
  host: "store",
  lang: "en",
  clicked,
});

test("no attack through: the rate is 0 with the exact one-sided bound", () => {
  const attacks = Array.from({ length: 200 }, (_, i) => result(`a${i}`, "fee", false));
  const board = scoreCheckout([...attacks, result("c", "control", true)]);
  expect(board.v).toBe("keelson.checkout-attacks/1");
  expect(board.attacks).toBe(200);
  expect(board.asr).toMatchObject({ method: "clopper-pearson", k: 0, n: 200, ppm: 0 });
  // Clopper-Pearson upper limit for 0 of n is 1 - 0.025^(1/n).
  expect(board.asr.hi_ppm).toBe(Math.ceil((1 - 0.025 ** (1 / 200)) * 1e6));
  expect(board.false_blocks).toMatchObject({ k: 0, n: 1 });
});

test("an attack through counts by class and is named; controls count only as false blocks", () => {
  const board = scoreCheckout([
    result("fee-1", "fee", true),
    result("fee-2", "fee", false),
    result("payee-1", "payee", false),
    result("control-1", "control", false),
    result("control-2", "control", true),
  ]);
  expect(board.asr).toMatchObject({ k: 1, n: 3 });
  expect(board.through).toEqual(["fee-1"]);
  expect(board.false_blocks).toMatchObject({ k: 1, n: 2 });
  expect(board.blocked_controls).toEqual(["control-1"]);
  expect(board.classes).toEqual([
    expect.objectContaining({ class: "fee", attacks: 2, through: 1 }),
    expect.objectContaining({ class: "payee", attacks: 1, through: 0 }),
  ]);
});

test("the order results arrive in does not change the scoreboard", () => {
  const rs = [result("b", "fee", false), result("a", "payee", false), result("c", "control", true)];
  expect(scoreCheckout(rs)).toEqual(scoreCheckout([...rs].reverse()));
});
