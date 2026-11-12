from keelson import Keelson, quote, verify_alibi

keelson = Keelson()  # signed in with `keelson login`
why = "I buy one pair of Pace Lite running shoes, size 10, at RunFast on the PayPal sandbox, and nothing else."
req = keelson.mandates.request(name="Quickstart", reason=why, per_purchase="$100", total="$100", until="1h")
print(f"Approve with your passkey: {req.approval_url}", flush=True)
mandate = keelson.mandates.wait_for_approval(req.id)
q = quote([{"productUrl": "https://store.keelson.finance/products/pace-lite", "size": "10", "qty": 1}])
seen = {**q["sources"], "observation": "Pace Lite, size 10, $99.00."}
sealed = keelson.evidence.seal(mandate_id=mandate.id, sources=seen)
signed = keelson.purchases.countersign(mandate=mandate, evidence_root=sealed["evidenceRoot"], cart=q["cart"])
report = verify_alibi(keelson.alibis.retrieve(keelson.purchases.wait_for(signed.purchase_id).id))
print(f"Bought {signed.purchase_id}. Alibi: {report['verdict']}")
