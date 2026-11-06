import type { Card } from "@keelson/mandate";
import { describe, expect, it } from "vitest";
import { cardText } from "../src/verify.ts";

const card: Card = {
  rows: [
    { field: "mode", label: "Mode", values: ["Immediate"], color: "green", answers: "Keelson" },
    {
      field: "total",
      label: "Maximum total",
      values: ["100.00 USD"],
      color: "gray",
      answers: "You",
    },
    {
      field: "variant",
      label: "Variant",
      values: ["size_us: 10", "color: any"],
      color: "amber",
      answers: "Agent operator",
    },
  ],
  warnings: [],
};

describe("cardText", () => {
  it("lists the compiled rows and marks the unsettled ones", () => {
    expect(cardText(card, ["total"])).toBe(
      "Maximum total (unsettled): 100.00 USD\nVariant: size_us: 10; color: any",
    );
  });
});
