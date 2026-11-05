import { DST, hashObject, newId } from "@keelson/core";
import { beforeAll, describe, expect, it } from "vitest";
import { paypalConfig } from "../../src/config.js";
import { encodeVerdictRef } from "../../src/ids.js";
import { createPayout, getPayoutBatch } from "../../src/payouts.js";
import { createPayPal, type PayPal } from "../../src/sdk.js";
import { TokenCache } from "../../src/token.js";

let paypal: PayPal;

beforeAll(() => {
  const cfg = paypalConfig();
  paypal = createPayPal(cfg, new TokenCache(cfg));
});

describe("payouts (sandbox)", () => {
  it("pays $1.00 and round-trips the sender item id", async () => {
    const receiver = process.env.PAYPAL_SANDBOX_PERSONAL_EMAIL;
    if (!receiver) throw new Error("PAYPAL_SANDBOX_PERSONAL_EMAIL is required");

    const verdictId = newId();
    const senderItemId = encodeVerdictRef(
      verdictId,
      hashObject(DST.alibi, { verdict_id: verdictId }),
    );
    const senderBatchId = `ks-test-${newId()}`;

    const created = await createPayout(paypal.fetch, {
      senderBatchId,
      items: [
        {
          amount: { currency: "USD", minor: 100n },
          receiver,
          senderItemId,
          note: "Keelson sandbox payout test",
        },
      ],
    });
    const batchId = created.batch_header.payout_batch_id;
    expect(created.batch_header.sender_batch_header.sender_batch_id).toBe(senderBatchId);

    const deadline = Date.now() + 60_000;
    let batch = await getPayoutBatch(paypal.fetch, batchId);
    while (batch.batch_header.batch_status !== "SUCCESS" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3_000));
      batch = await getPayoutBatch(paypal.fetch, batchId);
    }

    const item = batch.items?.[0];
    console.info(
      `payout ${batchId}: batch ${batch.batch_header.batch_status}, item ${item?.transaction_status}`,
    );
    expect(item?.payout_item.sender_item_id).toBe(senderItemId);
    expect(item?.payout_item.receiver).toBe(receiver);
    expect(item?.payout_item.amount).toMatchObject({ currency: "USD", value: "1.00" });
    expect(batch.batch_header.batch_status).toBe("SUCCESS");
    expect(item?.transaction_status).toBe("SUCCESS");
  });
});
