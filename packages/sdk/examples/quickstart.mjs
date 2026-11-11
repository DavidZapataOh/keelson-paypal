import { Keelson, quote } from "@keelson/sdk";
import { verifyAlibi } from "@keelson/verify";

const keelson = new Keelson(); // signed in with `npx keelson login`
const why = "I buy one pair of Cloud Daily running shoes, size 10, at RunFast on the PayPal sandbox, and nothing else.";
const req = await keelson.mandates.request({ name: "Quickstart", reason: why, perPurchase: "$120", total: "$120", until: "1h" });
console.log(`Approve with your passkey: ${req.approvalUrl}`);
const mandate = await keelson.mandates.waitForApproval(req.id);
const { cart, sources } = await quote([{ productUrl: "https://store.keelson.finance/products/cloud-daily", size: "10", qty: 1 }]);
const { evidenceRoot } = await keelson.evidence.seal({ mandateId: mandate.id, sources: { ...sources, observation: "Cloud Daily, size 10, $119.00." } });
const { purchaseId } = await keelson.purchases.countersign({ mandate, evidenceRoot, cart });
const report = await verifyAlibi(await keelson.alibis.retrieve((await keelson.purchases.waitFor(purchaseId)).id));
console.log(`Bought ${purchaseId}. Alibi: ${report.verdict}`);
