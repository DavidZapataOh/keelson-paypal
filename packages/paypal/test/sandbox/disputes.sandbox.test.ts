import { PDFDocument } from "pdf-lib";
import { beforeAll, describe, expect, test } from "vitest";
import { paypalConfig } from "../../src/config.js";
import { adjudicate, getDispute, provideEvidence, requireEvidence } from "../../src/disputes.js";
import { fromSdkError } from "../../src/errors.js";
import { parseInvoiceId } from "../../src/ids.js";
import { createPayPal, type PayPal } from "../../src/sdk.js";
import { TokenCache } from "../../src/token.js";

const disputeId = process.env.PAYPAL_SANDBOX_DISPUTE_ID;

let paypal: PayPal;

beforeAll(() => {
  const cfg = paypalConfig();
  paypal = createPayPal(cfg, new TokenCache(cfg));
});

async function onePagePdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage().drawText(text, { x: 50, y: 700, size: 14 });
  return doc.save();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("disputes (sandbox)", () => {
  test.skipIf(!disputeId)(
    "reads, answers and resolves a buyer-opened dispute",
    async () => {
      const id = disputeId as string;
      const first = await getDispute(paypal.fetch, id);
      const tx = first.disputed_transactions?.[0];
      expect(tx?.seller_transaction_id).toBeTruthy();

      const { result: capture } = await paypal.payments
        .getCapturedPayment({ captureId: tx?.seller_transaction_id as string })
        .catch((e) => Promise.reject(fromSdkError(e)));
      expect(capture.invoiceId).toBeTruthy();
      expect(parseInvoiceId(capture.invoiceId as string)).not.toBeNull();
      expect(tx?.invoice_number).toBe(capture.invoiceId);
      console.info(
        `dispute ${id}: disputed_transactions[0].custom = ${JSON.stringify(tx?.custom ?? null)}, ` +
          `capture custom_id = ${JSON.stringify(capture.customId ?? null)}`,
      );

      // Documented transitions only: require-evidence (UNDER_REVIEW -> WAITING_FOR_SELLER_RESPONSE),
      // provide-evidence (WAITING_FOR_SELLER_RESPONSE), adjudicate (UNDER_REVIEW).
      let provided = false;
      let adjudicated = false;
      let last = "";
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const d = await getDispute(paypal.fetch, id);
        if (d.status !== last) {
          console.info(`dispute ${id}: status ${d.status}, stage ${d.dispute_life_cycle_stage}`);
          last = d.status;
        }
        if (d.status === "RESOLVED") break;
        const links = new Set(d.links?.map((l) => l.rel));

        if (
          d.status === "WAITING_FOR_SELLER_RESPONSE" &&
          links.has("provide-evidence") &&
          !provided
        ) {
          await provideEvidence(
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
            [{ name: "evidence.pdf", bytes: await onePagePdf("Keelson sandbox evidence") }],
          );
          provided = true;
        } else if (d.status === "UNDER_REVIEW" && !provided && links.has("require-evidence")) {
          await requireEvidence(paypal.fetch, id, "SELLER_EVIDENCE");
        } else if (
          d.status === "UNDER_REVIEW" &&
          provided &&
          links.has("adjudicate") &&
          !adjudicated
        ) {
          await adjudicate(paypal.fetch, id, "SELLER_FAVOR");
          adjudicated = true;
        }
        await sleep(3_000);
      }

      expect(provided).toBe(true);
      expect(adjudicated).toBe(true);
      expect((await getDispute(paypal.fetch, id)).status).toBe("RESOLVED");
    },
    180_000,
  );
});

if (!disputeId) {
  console.info(
    "skipped: open a sandbox dispute from the buyer UI and set PAYPAL_SANDBOX_DISPUTE_ID",
  );
}
