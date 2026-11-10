// Runs the guarded agent for a mandate a user signed in the app, against Keelson's API as the
// agent's OAuth client, and prints the countersign answer.
//
//   KEELSON_AGENT_KEY                          the private JWK of the `cnf` key the mandate names
//   KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET   an OAuth client with countersign and evidence scopes
//   KEELSON_EVIDENCE_AGE_RECIPIENT             seals the unredacted evidence originals
//   MANDATE_ID, OPEN_MANDATE, AUTHORIZATION_ID the user's mandate, as issued, and its hold
//   STORE_URL (the demo store), KEELSON_API_URL, KERNEL_API_KEY, ANTHROPIC_API_KEY
import Anthropic from "@anthropic-ai/sdk";
import { parseMandate } from "@keelson/mandate";
import { runAgent } from "../src/agent.ts";
import { checkout, quoteCart } from "../src/checkout.ts";
import { agentKey, apiClient } from "../src/keelson.ts";
import { openSession } from "../src/kernel.ts";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const store = process.env.STORE_URL ?? "https://store.keelson.finance";
const hosts = [new URL(store).hostname];
const openMandate = env("OPEN_MANDATE");
// The mandate is the SD-JWT disclosure whose value is the `keelson.mandate.1` payload.
const mandate = parseMandate(
  openMandate
    .split("~")
    .slice(1)
    .flatMap((d) => {
      try {
        const value = (JSON.parse(Buffer.from(d, "base64url").toString()) as unknown[]).at(-1);
        return (value as { v?: string })?.v === "keelson.mandate.1" ? [value] : [];
      } catch {
        return [];
      }
    })[0],
);
const keelson = apiClient({
  apiUrl: process.env.KEELSON_API_URL ?? "https://api.keelson.finance",
  clientId: env("KEELSON_CLIENT_ID"),
  clientSecret: env("KEELSON_CLIENT_SECRET"),
  scopes: ["countersign:write", "evidence:write"],
});
const { privateKey } = await agentKey(env("KEELSON_AGENT_KEY"));
const session = await openSession({ hosts });
try {
  console.error(`live view ${session.liveViewUrl ?? "(none)"}`);
  const run = await runAgent({
    client: new Anthropic(),
    backbone: "guarded",
    mandate,
    startUrl: `${store}/`,
    hosts,
    context: session.context,
    page: session.page,
    onStep: (s) => console.error(`+${s.at}ms ${s.kind} ${s.detail.slice(0, 160)}`),
  });
  if (!run.proposal) throw new Error(`no cart proposed (${run.outcome})`);
  const result = await checkout({
    keelson,
    headers: {},
    hold: {
      mandateId: env("MANDATE_ID"),
      openMandate,
      agentKey: privateKey,
      authorizationId: env("AUTHORIZATION_ID"),
    },
    session,
    quote: await quoteCart(store, run.proposal),
    observation: run.reads.join("\n\n"),
    recipient: env("KEELSON_EVIDENCE_AGE_RECIPIENT"),
  });
  console.log(
    JSON.stringify({ status: result.status, purchase: result.requestId, ...result.body }),
  );
} finally {
  await session.close();
}
