export type Language = "typescript" | "python";

/** Keelson's full documentation. */
export const DOCS = "https://docs.keelson.finance";

export interface Step {
  id: "install" | "login" | "mandate" | "purchase" | "verify";
  /** The page of the full docs that covers the step. */
  docs: string;
  title: string;
  body: string;
  code: Record<Language, string>;
}

const QUICKSTART_TS = `const keelson = new Keelson();
const req = await keelson.mandates.request({ name: "My agent", reason, perPurchase: "$100", total: "$100", until: "1h" });
console.log(req.approvalUrl); // you approve with your passkey
const mandate = await keelson.mandates.waitForApproval(req.id);`;

const QUICKSTART_PY = `keelson = Keelson()
req = keelson.mandates.request(name="My agent", reason=reason, per_purchase="$100", total="$100", until="1h")
print(req.approval_url)  # you approve with your passkey
mandate = keelson.mandates.wait_for_approval(req.id)`;

/** The five steps from an empty folder to a verified purchase, in both languages. */
export const STEPS: Step[] = [
  {
    id: "install",
    docs: `${DOCS}/sdk/install`,
    title: "Install",
    body: "Two packages: the SDK, and the verifier that checks receipts on your machine.",
    code: {
      typescript: "npm install @keelson-finance/sdk @keelson-finance/verifier",
      python: "pip install keelson-finance",
    },
  },
  {
    id: "login",
    docs: `${DOCS}/sdk/authentication`,
    title: "Sign in from your terminal",
    body: "Your browser opens; you allow it once. No key to paste.",
    code: { typescript: "npx @keelson-finance/sdk login", python: "keelson login" },
  },
  {
    id: "mandate",
    docs: `${DOCS}/sdk/mandates`,
    title: "Ask for a mandate",
    body: "Your agent asks for limits. You sign them with your passkey and hold the budget on PayPal.",
    code: { typescript: QUICKSTART_TS, python: QUICKSTART_PY },
  },
  {
    id: "purchase",
    docs: `${DOCS}/sdk/purchases`,
    title: "Buy within it",
    body: "Two TEEs check the cart against what you signed before PayPal captures it.",
    code: {
      typescript:
        "const { evidenceRoot } = await keelson.evidence.seal({ mandateId: mandate.id, sources });\nconst { purchaseId } = await keelson.purchases.countersign({ mandate, evidenceRoot, cart });",
      python:
        'sealed = keelson.evidence.seal(mandate_id=mandate.id, sources=sources)\nsigned = keelson.purchases.countersign(mandate=mandate, evidence_root=sealed["evidenceRoot"], cart=cart)',
    },
  },
  {
    id: "verify",
    docs: `${DOCS}/sdk/verify`,
    title: "Verify the receipt",
    body: "The Alibi checks out on your machine: both TEE signatures, the evidence, the public log.",
    code: {
      typescript: "const report = await verifyAlibi(await keelson.alibis.retrieve(purchaseId));",
      python: "report = verify_alibi(keelson.alibis.retrieve(signed.purchase_id))",
    },
  },
];
