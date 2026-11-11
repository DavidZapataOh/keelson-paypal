import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { sanitize } from "../src/capture.ts";

const row = (text: string, region = "", testid = "") => ({ text, region, testid });

describe("what the gate logs of a held page", () => {
  test("keeps amounts with their marks, checkout words, codes and regions", () => {
    expect(
      sanitize(
        [
          row("Total $2.95 USD", "section", "cart-total"),
          row("Pagarás $10.231 COP", "region"),
          row("Saldo de PayPal $1.669 COP"),
          row("Tasa de conversión: 1 USD = 3.468,14 COP"),
        ],
        "es",
        "USD",
      ),
    ).toEqual([
      {
        amount: "$2.95 USD",
        kind: "target",
        context: "total",
        label: "Total",
        region: "section cart-total",
      },
      {
        amount: "$10.231 COP",
        kind: "other",
        context: "total",
        label: "Pagarás",
        region: "region",
      },
      {
        amount: "$1.669 COP",
        kind: "other",
        context: "aside",
        label: "Saldo de PayPal",
        region: "",
      },
      {
        amount: "1 USD",
        kind: "target",
        context: "aside",
        label: "Tasa de conversión:",
        region: "",
      },
      { amount: "3.468,14 COP", kind: "other", context: "aside", label: "=", region: "" },
    ]);
  });

  test("redacts names, emails, addresses, card, bank, ID and account numbers", () => {
    const seen = sanitize(
      [
        row("Enviar a Ana María Prueba, Calle 85 # 11-53, Bogotá 110221 $2.95 USD"),
        row("ana.prueba@example.test · +57 300 123 4567 · Total $2.95 USD"),
        row("Visa •••• 4242 · Bancolombia ****9876 · CC 1.023.456.789 $0.00 USD"),
        row("PayPal ID 7XK2PQ9ZJ3B4C $1.00 USD", "dialog", "payer-7XK2PQ9ZJ3B4C-email"),
        row("Recibo 1.234.567.890 USD"),
      ],
      "es",
      "USD",
    );
    const log = JSON.stringify(seen);
    for (const secret of [
      "Ana",
      "María",
      "Prueba",
      "Calle",
      "Bogot",
      "110221",
      "example",
      "@",
      "300",
      "4567",
      "4242",
      "Bancolombia",
      "9876",
      "023",
      "456",
      "789",
      "7XK2",
      "email",
      "1.234.567.890",
    ]) {
      expect(log, secret).not.toContain(secret);
    }
    expect(seen.map((s) => s.amount)).toEqual(
      expect.arrayContaining(["$2.95 USD", "$0.00 USD", "$1.00 USD", "#.###.###.### USD"]),
    );
    expect(seen.find((s) => s.amount === "$1.00 USD")?.region).toBe("dialog payer-*-*");
  });

  test("no word outside the checkout's own and no unmarked digits ever reach the log", () => {
    // Words no checkout writes (a name, a street) and digit strings (a card, a phone, an ID).
    const word = fc.stringMatching(/^Zq[a-zñáéíóú]{2,8}$/);
    const digits = fc.stringMatching(/^9\d{3,11}$/);
    fc.assert(
      fc.property(
        fc.array(fc.oneof(word, digits), { minLength: 1, maxLength: 6 }),
        fc.constantFrom("Total", "Saldo de PayPal", "Pagarás", "Subtotal", "Envío"),
        fc.constantFrom("$2.95 USD", "US$2,95", "$10.231 COP", "1 USD = 3.468,14 COP"),
        (secrets, label, amount) => {
          const text = `${secrets.join(" ")} ${label} ${amount} ${secrets.join(", ")}`;
          const log = JSON.stringify(sanitize([row(text, "main", secrets.join("-"))], "es", "USD"));
          for (const secret of secrets) expect(log, text).not.toContain(secret);
        },
      ),
      { numRuns: 5_000 },
    );
  });
});
