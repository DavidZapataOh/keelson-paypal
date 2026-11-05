import { PDFDocument } from "pdf-lib";
import { beforeAll, describe, expect, test } from "vitest";
import { paypalConfig } from "../../src/config.js";
import { adjudicate, getDispute, provideEvidence, requireEvidence } from "../../src/disputes.js";
import { createPayPal, type PayPal } from "../../src/sdk.js";
import { TokenCache } from "../../src/token.js";

const disputeId = process.env.PAYPAL_SANDBOX_DISPUTE_ID;
const CAPTURE_ID = "6GJ620968U5281204";

let cfg: ReturnType<typeof paypalConfig>;
let paypal: PayPal;

beforeAll(() => {
  cfg = paypalConfig();
  paypal = createPayPal(cfg, new TokenCache(cfg));
});

async function onePagePdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage().drawText(text, { x: 50, y: 700, size: 14 });
  return doc.save();
}

async function waitForStatus(status: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let d = await getDispute(paypal.fetch, disputeId as string);
  while (d.status !== status && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    d = await getDispute(paypal.fetch, disputeId as string);
  }
  return d;
}

describe("disputes (sandbox)", () => {
  test.skipIf(!disputeId)(
    "reads, answers and resolves a buyer-opened dispute",
    async () => {
      const id = disputeId as string;
      const dispute = await getDispute(paypal.fetch, id);
      const tx = dispute.disputed_transactions?.[0];

      const { result: capture } = await paypal.payments.getCapturedPayment({
        captureId: CAPTURE_ID,
      });
      expect(tx?.invoice_number).toBe(capture.invoiceId);
      console.info(
        `dispute ${id}: status ${dispute.status}, stage ${dispute.dispute_life_cycle_stage}, ` +
          `disputed_transactions[0].custom = ${JSON.stringify(tx?.custom ?? null)}, ` +
          `capture custom_id = ${JSON.stringify(capture.customId ?? null)}`,
      );

      const pdf = await onePagePdf("Keelson sandbox evidence: order confirmation");
      const evidence = await provideEvidence(
        paypal.fetch,
        id,
        {
          evidences: [
            {
              evidence_type: "PROOF_OF_FULFILLMENT",
              notes: "Sandbox evidence submitted by the integration test.",
              documents: [{ name: "evidence.pdf" }],
            },
          ],
        },
        [{ name: "evidence.pdf", bytes: pdf }],
      );
      expect(evidence.links?.some((l) => l.rel === "self")).toBe(true);

      await requireEvidence(paypal.fetch, cfg, id, "SELLER_EVIDENCE");
      await adjudicate(paypal.fetch, cfg, id, "SELLER_FAVOR");

      const resolved = await waitForStatus("RESOLVED", 120_000);
      expect(resolved.status).toBe("RESOLVED");
    },
    180_000,
  );
});

if (!disputeId) {
  console.info(
    "skipped: open a sandbox dispute from the buyer UI and set PAYPAL_SANDBOX_DISPUTE_ID",
  );
}
