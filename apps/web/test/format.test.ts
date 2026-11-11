import { describe, expect, test } from "vitest";
import { major, money } from "../lib/format";

describe("money in minor units, per currency (ISO 4217)", () => {
  test.each([
    ["USD", "9400", 94, "$94.00"],
    ["JPY", "9400", 9400, "¥9,400"],
    ["KWD", "9400", 9.4, "KWD 9.400"],
  ])("%s reads %s minor units", (currency, minor, value, shown) => {
    expect(major(minor, currency)).toBe(value);
    expect(money(minor, currency).replace(/ /g, " ")).toBe(shown);
  });
});
