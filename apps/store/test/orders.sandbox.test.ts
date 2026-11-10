import { CheckoutPaymentIntent } from "@paypal/paypal-server-sdk";
import { describe, expect, test } from "vitest";
import { STORE_REFERENCE } from "../src/orders.ts";
import { deps, ORIGIN, req } from "./setup.ts";

const post = (path: string, body?: unknown) =>
  req(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("orders (PayPal sandbox)", { timeout: 60_000 }, () => {
  test("an order is a CAPTURE order for the catalog total, paid to RunFast", async () => {
    const started = performance.now();
    const res = await post("/api/orders", {
      lines: [
        { handle: "tempo-3", size: "10", qty: 2 },
        { handle: "pace-lite", size: "9", qty: 1 },
      ],
    });
    console.info(`create order: ${Math.round(performance.now() - started)} ms`);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const { result: order } = await deps.paypal.orders.getOrder({ id });
    expect(order.intent).toBe(CheckoutPaymentIntent.Capture);
    // A `payment_source.paypal` order waits for the buyer as PAYER_ACTION_REQUIRED.
    expect(order.status).toBe("PAYER_ACTION_REQUIRED");
    const unit = order.purchaseUnits?.[0];
    expect(unit?.referenceId).toBe(STORE_REFERENCE);
    expect(unit?.payee?.merchantId).toBe("A4WCRYD5EYDF2");
    expect(unit?.amount).toMatchObject({
      currencyCode: "USD",
      value: "357.00",
      breakdown: { itemTotal: { currencyCode: "USD", value: "357.00" } },
    });
    expect(unit?.items?.map((i) => [i.sku, i.quantity, i.unitAmount.value, i.url])).toEqual([
      ["RF-TMP3-10", "2", "129.00", `${ORIGIN}/products/tempo-3`],
      ["RF-PACE-9", "1", "99.00", `${ORIGIN}/products/pace-lite`],
    ]);
  });

  test("a client cannot send a price", async () => {
    const res = await post("/api/orders", {
      lines: [{ handle: "tempo-3", size: "10", qty: 1, unit_minor: 1 }],
    });
    expect(res.status).toBe(422);
  });

  test("an order the buyer has not approved is not captured", async () => {
    const created = await post("/api/orders", {
      lines: [{ handle: "tempo-3", size: "10", qty: 1 }],
    });
    const { id } = (await created.json()) as { id: string };
    const res = await post(`/api/orders/${id}/capture`);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ title: "Order not approved" });
    const page = await req(`/orders/${id}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("not been paid");
  });

  test("the store shows and captures only its own orders", async () => {
    const { result: other } = await deps.paypal.orders.createOrder({
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [{ amount: { currencyCode: "USD", value: "1.00" } }],
      },
    });
    const id = other.id as string;
    expect((await req(`/orders/${id}`)).status).toBe(404);
    expect((await post(`/api/orders/${id}/capture`)).status).toBe(404);
    expect((await req("/orders/not-an-order")).status).toBe(404);
  });
});
