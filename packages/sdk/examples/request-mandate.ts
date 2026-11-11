// Asks the user for a mandate as the operator's agent and waits for their answer.
//
//   KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET   the agent's OAuth client
//
//   node examples/request-mandate.ts
import { clientCredentials, Keelson, KeelsonAgent } from "@keelson/sdk";

const keelson = new Keelson({
  auth: clientCredentials({
    clientId: process.env.KEELSON_CLIENT_ID ?? "",
    clientSecret: process.env.KEELSON_CLIENT_SECRET ?? "",
    scopes: ["countersign:write", "evidence:write"],
  }),
});
const agent = new KeelsonAgent(keelson);

const asked = await agent.requestMandate({
  name: "Running shoes agent",
  reason:
    "I will buy one pair of running shoes in your size from RunFast, comparing the models in stock and staying under the price you set.",
  perPurchaseMinor: 15_000,
  totalMinor: 15_000,
  until: new Date(Date.now() + 24 * 3_600_000).toISOString(),
});
// Show the user the link and the number together; they pick the number on Keelson's page.
console.log(asked.next.say);
const answer = await agent.settle(asked);
console.log(answer.status, answer.message);
