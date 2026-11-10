// Runs the guarded agent for a mandate a user signed in the app, against Keelson's API as the
// agent's OAuth client, and prints the countersign answer.
//
//   KEELSON_AGENT_KEY                          the private JWK of the `cnf` key the mandate names
//   KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET   an OAuth client with countersign and evidence scopes
//   KEELSON_EVIDENCE_AGE_RECIPIENT             seals the unredacted evidence originals
//   AGENT_ID                                   the operator the mandate names (DEMO_AGENT_ID)
//   MANDATE_ID                                 optional: which of its active mandates; the newest by default
//   STORE_URL (the demo store), KEELSON_API_URL, KERNEL_API_KEY, ANTHROPIC_API_KEY
import Anthropic from "@anthropic-ai/sdk";
import { parseMandate } from "@keelson/mandate";
import { runAgent } from "../src/agent.ts";
import { checkout, quoteCart } from "../src/checkout.ts";
import { agentKey, apiClient, operatorMandates } from "../src/keelson.ts";
import { openSession } from "../src/kernel.ts";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const store = process.env.STORE_URL ?? "https://keelson-store.onrender.com";
const hosts = [new URL(store).hostname];
const keelson = apiClient({
  apiUrl: process.env.KEELSON_API_URL ?? "https://api.keelson.finance",
  clientId: env("KEELSON_CLIENT_ID"),
  clientSecret: env("KEELSON_CLIENT_SECRET"),
  scopes: ["countersign:write", "evidence:write"],
});
const listed = await operatorMandates(keelson, BigInt(env("AGENT_ID")));
const held = listed.find((m) =>
  process.env.MANDATE_ID ? m.id === process.env.MANDATE_ID : m.authorizationId !== null,
);
if (!held?.authorizationId) throw new Error("no active mandate held as a whole for this operator");
const openMandate = held.openMandate;
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
      mandateId: held.id,
      openMandate,
      agentKey: privateKey,
      authorizationId: held.authorizationId,
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
