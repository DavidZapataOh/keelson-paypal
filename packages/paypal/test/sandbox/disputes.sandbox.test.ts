import { PDFDocument } from "pdf-lib";
import { beforeAll, describe, expect, test } from "vitest";
import { paypalConfig } from "../../src/config.ts";
import {
  adjudicate,
  escalate,
  getDispute,
  provideEvidence,
  requireEvidence,
} from "../../src/disputes.ts";
import { fromSdkError } from "../../src/errors.ts";
import { parseInvoiceId } from "../../src/ids.ts";
import { createPayPal, type PayPal } from "../../src/sdk.ts";
import { TokenCache } from "../../src/token.ts";

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

      // Link rels use underscores. require_evidence/adjudicate need UNDER_REVIEW in the
      // CHARGEBACK stage; an INQUIRY must be escalated first.
      let escalated = false;
      let requested = false;
      let provided = false;
      let adjudicated = false;
      let last = "";
      const seconds = Number(process.env.PAYPAL_DISPUTE_TIMEOUT_SECONDS ?? 120);
      const deadline = Date.now() + seconds * 1000;
      const log = (m: string) => console.info(`${new Date().toISOString()} dispute ${id}: ${m}`);
      while (Date.now() < deadline) {
        const d = await getDispute(paypal.fetch, id);
        const links = new Set(d.links?.map((l) => l.rel));
        const state = `${d.status}/${d.dispute_life_cycle_stage} [${[...links].join(", ")}]`;
        if (state !== last) {
          log(state);
          last = state;
        }
        if (d.status === "RESOLVED") break;

        if (d.status === "WAITING_FOR_SELLER_RESPONSE" && links.has("provide_evidence")) {
          if (!provided) {
            await provideEvidence(
              paypal.fetch,
              id,
              {
                evidences: [
                  {
                    evidence_type: "OTHER",
                    notes: "Sandbox evidence submitted by the integration test.",
                    documents: [{ name: "evidence.pdf" }],
                  },
                ],
              },
              [{ name: "evidence.pdf", bytes: await onePagePdf("Keelson sandbox evidence") }],
            );
            provided = true;
            log("evidence provided");
          }
        } else if (d.status === "WAITING_FOR_SELLER_RESPONSE" && links.has("escalate")) {
          if (!escalated) {
            await escalate(paypal.fetch, id, "Escalating to a claim for resolution.");
            escalated = true;
            log("escalated");
          }
        } else if (
          d.status === "UNDER_REVIEW" &&
          (provided || !links.has("require_evidence")) &&
          links.has("adjudicate")
        ) {
          if (!adjudicated) {
            await adjudicate(paypal.fetch, id, "SELLER_FAVOR");
            adjudicated = true;
            log("adjudicated SELLER_FAVOR");
          }
        } else if (d.status === "UNDER_REVIEW" && !provided && links.has("require_evidence")) {
          if (!requested) {
            await requireEvidence(paypal.fetch, id, "SELLER_EVIDENCE");
            requested = true;
            log("evidence required from the seller");
          }
        } else if (
          !(escalated || requested || provided || ["OPEN", "UNDER_REVIEW"].includes(d.status))
        ) {
          throw new Error(`no documented action for ${state}`);
        }
        await sleep(3_000);
      }

      const final = await getDispute(paypal.fetch, id);
      if (final.status !== "RESOLVED") {
        throw new Error(
          `dispute ${id} is still ${last} after the deadline; rerun later, the test resumes from the current state`,
        );
      }
      expect(final.status).toBe("RESOLVED");
    },
    3_600_000,
  );
});

if (!disputeId) {
  console.info(
    "skipped: open a sandbox dispute from the buyer UI and set PAYPAL_SANDBOX_DISPUTE_ID",
  );
}
