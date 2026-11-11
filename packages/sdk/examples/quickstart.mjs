import { Keelson, quote } from "@keelson/sdk";
import { verifyAlibi } from "@keelson/verifier";

const keelson = new Keelson(); // signed in with `npx keelson login`
const why = "I buy one pair of Pace Lite running shoes, size 10, at RunFast on the PayPal sandbox, and nothing else.";
const req = await keelson.mandates.request({ name: "Quickstart", reason: why, perPurchase: "$100", total: "$100", until: "1h" });
console.log(`Approve with your passkey: ${req.approvalUrl}`);
const mandate = await keelson.mandates.waitForApproval(req.id);
const { cart, sources } = await quote([{ productUrl: "https://store.keelson.finance/products/pace-lite", size: "10", qty: 1 }]);
const { evidenceRoot } = await keelson.evidence.seal({ mandateId: mandate.id, sources: { ...sources, observation: "Pace Lite, size 10, $99.00." } });
const { purchaseId } = await keelson.purchases.countersign({ mandate, evidenceRoot, cart });
const report = await verifyAlibi(await keelson.alibis.retrieve((await keelson.purchases.waitFor(purchaseId)).id));
console.log(`Bought ${purchaseId}. Alibi: ${report.verdict}`);
