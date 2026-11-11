// Buys one item from Keelson's demo store under a mandate the user signed and held, as the
// operator's agent: seals the evidence, checks the cart, gets it countersigned and waits until
// PayPal captured it on the sandbox.
//
//   KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET   the agent's OAuth client
//   KEELSON_AGENT_ID                           the operator's ERC-8004 agent id
//   KEELSON_AGENT_KEY                          the private P-256 JWK the mandates name
//
//   node examples/countersign.ts
import { clientCredentials, importAgentKey, Keelson, KeelsonAgent } from "@keelson/sdk";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const STORE = "https://store.keelson.finance";

const keelson = new Keelson({
  auth: clientCredentials({
    clientId: env("KEELSON_CLIENT_ID"),
    clientSecret: env("KEELSON_CLIENT_SECRET"),
    scopes: ["countersign:write", "evidence:write"],
  }),
});
const agent = new KeelsonAgent(keelson, {
  agentId: env("KEELSON_AGENT_ID"),
  agentKey: await importAgentKey(env("KEELSON_AGENT_KEY")),
});

// The store prices the cart; the agent only picks the product, the size and the quantity.
const product = await (await fetch(`${STORE}/api/products/tempo-3`)).json();
const { cart } = await (
  await fetch(`${STORE}/api/cart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lines: [{ handle: "tempo-3", size: "9", qty: 1 }] }),
  })
).json();

const held = await agent.confirmMandate();
if (held.status !== "success" || !("mandate" in held) || !held.mandate) {
  throw new Error(held.next.say);
}
const mandateId = held.mandate.id;

const sealed = await agent.submitEvidence({
  mandateId,
  product,
  cart,
  observation: "Tempo 3, size 9, blue, $129.00, in stock, 30-day free returns.",
});
if (sealed.status !== "success" || !("evidenceRoot" in sealed)) throw new Error(sealed.message);

const check = await agent.checkCart({ mandateId, cart });
if (check.status !== "success") throw new Error(check.next.say);

// Countersign once; from here on the purchase is polled, never sent again.
const sent = await agent.requestCountersign({ mandateId, evidenceRoot: sealed.evidenceRoot, cart });
const done = await agent.settle(sent);
console.log(done.status, done.message);
