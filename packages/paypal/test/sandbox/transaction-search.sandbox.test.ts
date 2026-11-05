import { beforeAll, describe, expect, it } from "vitest";
import { paypalConfig } from "../../src/config.js";
import { fromSdkError } from "../../src/errors.js";
import { createPayPal, type PayPal } from "../../src/sdk.js";
import { TokenCache } from "../../src/token.js";

const MIN_AGE_MS = 3 * 60 * 60 * 1000;
const orderId = process.env.PAYPAL_SEARCHABLE_ORDER_ID;

let paypal: PayPal;
let customId: string | undefined;
let ageMs = 0;

beforeAll(async () => {
  const cfg = paypalConfig();
  paypal = createPayPal(cfg, new TokenCache(cfg));
  if (!orderId) return;
  const { result } = await paypal.orders
    .getOrder({ id: orderId })
    .catch((e) => Promise.reject(fromSdkError(e)));
  customId = result.purchaseUnits?.[0]?.customId;
  ageMs = Date.now() - new Date(result.createTime ?? Date.now()).getTime();
});

describe("transaction search (sandbox)", () => {
  it("finds the hold by custom_field once it has been indexed", async (ctx) => {
    if (!orderId) return ctx.skip("skipped: set PAYPAL_SEARCHABLE_ORDER_ID");
    if (ageMs < MIN_AGE_MS)
      return ctx.skip(`skipped: run is ${Math.round(ageMs / 60_000)} minutes old`);

    const end = new Date();
    const start = new Date(end.getTime() - 3 * 24 * 60 * 60 * 1000);
    const found: (string | undefined)[] = [];
    for (let page = 1; page <= 20; page++) {
      const { result } = await paypal.transactions
        .searchTransactions({
          startDate: start.toISOString(),
          endDate: end.toISOString(),
          fields: "transaction_info",
          pageSize: 100,
          page,
        })
        .catch((e) => Promise.reject(fromSdkError(e)));
      for (const t of result.transactionDetails ?? []) {
        found.push(t.transactionInfo?.customField);
      }
      if (page >= (result.totalPages ?? 1)) break;
    }
    expect(found).toContain(customId);
  });
});
