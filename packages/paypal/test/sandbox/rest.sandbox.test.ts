import { beforeAll, describe, expect, it } from "vitest";
import { paypalConfig } from "../../src/config.ts";
import { fromSdkError, PayPalError } from "../../src/errors.ts";
import { createPayPal, type PayPal } from "../../src/sdk.ts";
import { TokenCache } from "../../src/token.ts";

let paypal: PayPal;

beforeAll(() => {
  const cfg = paypalConfig();
  paypal = createPayPal(cfg, new TokenCache(cfg));
});

describe("rest core (sandbox)", () => {
  it("lists webhook event types", async () => {
    const res = await paypal.fetch<{ event_types: { name: string }[] }>(
      "GET",
      "/v1/notifications/webhooks-event-types",
    );
    expect(res.event_types.map((t) => t.name)).toContain("CUSTOMER.DISPUTE.CREATED");
  });

  it("raises PayPalError with the debug id on a missing order", async () => {
    const err = (await paypal
      .fetch("GET", "/v2/checkout/orders/DOES-NOT-EXIST")
      .catch((e) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.status).toBe(404);
    expect(err.name).toBe("RESOURCE_NOT_FOUND");
    expect(err.debugId).toBeTruthy();
  });
});

describe("sdk client (sandbox)", () => {
  it("converts SDK ApiError to PayPalError", async () => {
    const err = await paypal.orders.getOrder({ id: "DOES-NOT-EXIST" }).catch(fromSdkError);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).status).toBe(404);
    expect((err as PayPalError).name).toBe("RESOURCE_NOT_FOUND");
    expect((err as PayPalError).debugId).toBeTruthy();
  });
});
