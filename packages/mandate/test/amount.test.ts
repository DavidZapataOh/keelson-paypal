import { sha256, toHex } from "@keelson/core";
import { describe, expect, test } from "vitest";
import { amountConfirmChallenge, orderIdHash } from "../src/amount.ts";

const PAYEE = "A4WCRYD5EYDF2";

describe("orderIdHash", () => {
  test("is the SHA-256 of the order id", () => {
    expect(orderIdHash("9GW89972VN895905A")).toBe(
      toHex(sha256(new TextEncoder().encode("9GW89972VN895905A"))),
    );
  });
});

describe("amountConfirmChallenge", () => {
  const c = {
    purchase_id: "01M777FEC6WWKNJKJRVZ5C3T8B",
    order_id_hash: orderIdHash("9GW89972VN895905A"),
    currency: "USD",
    minor: 1234,
    payee: PAYEE,
  };

  test("is domain-separated SHA-256 over the JCS of what the user confirms", () => {
    const body = new TextEncoder().encode(
      `{"currency":"USD","minor":1234,"order_id_hash":"${c.order_id_hash}","payee":"${PAYEE}","purchase_id":"${c.purchase_id}"}`,
    );
    const prefix = new TextEncoder().encode("keelson/amount-confirm/v1");
    const input = new Uint8Array([...prefix, 0, ...body]);
    expect(toHex(amountConfirmChallenge(c))).toBe(toHex(sha256(input)));
  });

  test("changes with the amount", () => {
    expect(toHex(amountConfirmChallenge({ ...c, minor: 1235 }))).not.toBe(
      toHex(amountConfirmChallenge(c)),
    );
  });
});
