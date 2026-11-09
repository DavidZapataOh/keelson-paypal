import { PDFDocument } from "pdf-lib";
import { paypalConfig } from "./src/config.ts";
import { provideEvidence } from "./src/disputes.ts";
import { PayPalError } from "./src/errors.ts";
import { createPayPal } from "./src/sdk.ts";
import { TokenCache } from "./src/token.ts";

const cfg = paypalConfig();
const pp = createPayPal(cfg, new TokenCache(cfg));
const doc = await PDFDocument.create();
doc.addPage().drawText("x", { x: 50, y: 700 });
const pdf = await doc.save();
const variants: Record<string, any[]> = {
  ours: [
    { evidence_type: "PERMISSION_DESCRIPTION", notes: "The buyer signed a mandate." },
    { evidence_type: "ORDER_DETAILS", notes: "Order details.", documents: [{ name: "alibi.pdf" }] },
  ],
};
const v = variants[process.argv[2]!]!;
try {
  await provideEvidence(pp.fetch, process.argv[3]!, { evidences: v }, [
    { name: "alibi.pdf", bytes: pdf },
  ]);
  console.log("OK");
} catch (e) {
  if (e instanceof PayPalError) console.log(e.status, e.name, JSON.stringify(e.details), e.debugId);
  else throw e;
}
