---

name: keelson
description: Add Keelson to an app or an AI agent so it can buy within a mandate the user signs with a passkey, and verify each purchase's Alibi. Use when the user wants their agent to pay through PayPal with limits, or asks about @keelson-finance/sdk or keelson-finance.
---

# Integrating Keelson

Keelson lets an agent spend within a mandate the user signs with a passkey. Two TEEs check every
cart before PayPal captures it, and each purchase comes with an Alibi anyone can verify offline.
Everything runs on the PayPal sandbox and Arbitrum Sepolia.

1. Install: `npm install @keelson-finance/sdk @keelson-finance/verifier` (TypeScript) or `pip install keelson-finance`
   (Python). Sign in once with `npx keelson login` / `keelson login`.
2. Ask for a mandate with `mandates.request(...)` and show the user `approvalUrl`. Wait with
   `mandates.waitForApproval(id)` (`wait_for_approval`).
3. Price the cart from the store, seal what the agent saw with `evidence.seal(...)`, then
   `purchases.countersign({ mandate, evidenceRoot, cart })`.
4. On `OutcomeUnknownError`, never countersign again: `purchases.waitFor(err.requestId)`.
5. Verify with `verifyAlibi` from `@keelson-finance/verifier` (`verify_alibi` in Python).

For exact calls, use the `keelson-docs` MCP tools: `search_docs`, `get_operation`, `get_schema`,
and the `integrate_keelson` prompt.
