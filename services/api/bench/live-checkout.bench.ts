// Loads reflect-metadata before anything pulls in @keelson/attest (see tee/attest.ts).
import "../src/tee/attest.ts";
import { appendFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  ALFRED,
  apiClient,
  checkout,
  LIVE_ITEM,
  liveMandate,
  liveObservations,
  openSession,
  PayGate,
  type ProposedCart,
  paypalTransactionId,
  quoteShopify,
  runAgent,
  runCheckout,
} from "@keelson/agent";
import { decodeAlibi } from "@keelson/alibi";
import { verifyAlibi } from "@keelson/alibi/verify";
import { alibis, eq, purchases } from "@keelson/db";
import { parseMandate } from "@keelson/mandate";
import { loadAlibi } from "../src/alibi/issue.ts";
import { renderHarness } from "../test/render-live.ts";

// The shopping agent at a real store, with real money, under a fresh mandate for one digital
// copy of the live item from Alfred Music (at most $5). The buyer's PayPal session is the KERNEL
// profile PAYPAL_PROFILE, which the buyer signed in to himself. Run as a one-off job of
// keelson-api, like the money-path bench: the mandate is opened in this process, and the agent
// calls the deployed API as the operator's OAuth client (KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET).
//
//   LIVE_RUN=blocked  a cart that breaks the mandate (two copies, over the budget): Keelson denies
//                     it, and the agent's checkout is held at its first payment action.
//   LIVE_RUN=buy      the guarded agent finds the item and proposes it; Keelson countersigns it;
//                     the agent pays at the store's checkout with PayPal; the purchase's Alibi
//                     gets the PayPal transaction id and is published. Needs LIVE_BUY=yes.
//
// Prints a JSON summary, with no URL query, page text or credential, and exits 1 unless the run
// ends as it should.
const RUN = process.env.LIVE_RUN;
if (RUN !== "blocked" && (RUN !== "buy" || process.env.LIVE_BUY !== "yes")) {
  throw new Error("LIVE_RUN=blocked, or LIVE_RUN=buy with LIVE_BUY=yes");
}
const PROFILE = process.env.PAYPAL_PROFILE ?? "keelson-live-paypal";
const MAX_MINOR = 500;
/** No live purchase may cost more, whatever the mandate says. */
const CEILING_MINOR = 1_500;
const SETTLE_MS = 180_000;
const productUrl = `${ALFRED.origin}${LIVE_ITEM.path}`;

const h = await renderHarness();
const recipient = h.env.KEELSON_EVIDENCE_AGE_RECIPIENT as string;
if (!recipient) throw new Error("needs KEELSON_EVIDENCE_AGE_RECIPIENT");
const client = new Anthropic();
const API_URL = process.env.KEELSON_API_URL ?? "https://api.keelson.finance";
const agentApi = apiClient({
  apiUrl: API_URL,
  clientId: process.env.KEELSON_CLIENT_ID as string,
  clientSecret: process.env.KEELSON_CLIENT_SECRET as string,
  scopes: ["countersign:write", "evidence:write"],
});

async function settle(id: string) {
  const until = Date.now() + SETTLE_MS;
  for (;;) {
    const [p] = await h.db.select().from(purchases).where(eq(purchases.id, id));
    const [a] = await h.db
      .select({ id: alibis.purchaseId })
      .from(alibis)
      .where(eq(alibis.purchaseId, id));
    const done =
      p && (p.state === "FAILED" || ((p.state === "LOGGED" || p.state === "DENIED") && a));
    if (done || Date.now() > until) return p;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const log = (s: { at: number; kind: string; detail: string }) =>
  console.error(`+${s.at}ms ${s.kind} ${s.detail.slice(0, 160)}`);

try {
  let mandate: unknown;
  const hold = await h.openHold(MAX_MINOR, (m) => {
    liveMandate(m, MAX_MINOR, process.env.ALFRED_PAYPAL_MERCHANT_ID ?? "unknown");
    mandate = structuredClone(m);
  });
  const session = await openSession({ hosts: ALFRED.hosts, profile: PROFILE });
  try {
    let proposal: ProposedCart;
    let agent: Awaited<ReturnType<typeof runAgent>> | undefined;
    if (RUN === "buy") {
      agent = await runAgent({
        client,
        backbone: "guarded",
        mandate: parseMandate(structuredClone(mandate)),
        startUrl: `${ALFRED.origin}/search?q=The+Change+Piano+Vocal+Chords`,
        hosts: ALFRED.hosts,
        context: session.context,
        page: session.page,
        // Shut: nothing is countersigned while the agent looks for the cart.
        gate: new PayGate({ checkoutHosts: ALFRED.checkoutHosts }),
        onStep: log,
      });
      if (!agent.proposal) throw new Error(`no cart proposed (${agent.outcome})`);
      proposal = agent.proposal;
    } else {
      await session.page.goto(productUrl);
      proposal = {
        lines: [{ product_url: productUrl, size: "", qty: 2 }],
        reason: "two copies, over the mandate's budget",
      };
    }
    const quote = await quoteShopify(ALFRED, proposal);
    if (quote.total.minor > CEILING_MINOR) throw new Error(`the cart costs ${quote.total.display}`);
    // The store's scripts can still navigate the page after it loads; capture once it is quiet.
    await session.page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const skipped: string[] = [];
    const result = await checkout({
      keelson: agentApi,
      headers: {},
      hold: {
        mandateId: hold.mid,
        openMandate: hold.openMandate,
        agentKey: hold.key,
        authorizationId: hold.authorizationId,
      },
      session,
      quote,
      observation: agent ? agent.reads.join("\n\n") : "",
      recipient,
      observe: liveObservations({
        keelson: agentApi,
        headers: {},
        mandateId: hold.mid,
        productUrl,
        quote,
        skipped,
      }),
      live: { store: ALFRED.origin },
    });
    const allowed = result.status < 300 && result.body.decision === "allow";
    const gate = new PayGate({ checkoutHosts: ALFRED.checkoutHosts });
    if (allowed) gate.allow(quote.total);

    const paying = RUN === "blocked" || allowed;
    const run = paying
      ? await runCheckout({
          client,
          context: session.context,
          page: session.page,
          hosts: ALFRED.hosts,
          gate,
          quote,
          proposal,
          onStep: log,
        })
      : undefined;
    const purchase = await settle(result.requestId);
    let transactionId: string | undefined;
    let recorded: number | undefined;
    if (run?.outcome === "paid") {
      transactionId = await paypalTransactionId(
        session.context,
        session.page,
        quote.total.display,
        "Alfred",
      );
      if (transactionId) {
        const res = await agentApi.request(`/v1/purchases/${result.requestId}/paypal-transaction`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ transactionId }),
        });
        recorded = res.status;
      }
    }
    const alibiRes = await fetch(`${API_URL}/v1/alibis/${result.requestId}`);
    // The Alibi may not be issued yet when the API is asked: it is then read where Keelson keeps it.
    const bundle =
      alibiRes.status === 200
        ? decodeAlibi(new Uint8Array(await alibiRes.arrayBuffer()))
        : await loadAlibi(h.db, result.requestId);
    const verdict = bundle ? (await verifyAlibi(bundle)).verdict : undefined;
    const listed = (await (await fetch(`${API_URL}/v1/live-purchases`)).json()) as {
      purchases: { id: string }[];
    };

    const summary = {
      run: RUN,
      store: ALFRED.origin,
      mandate: hold.mid,
      cart: quote.cart.lines.map((l) => `${l.qty}x ${l.sku} @ ${l.unit_minor}`),
      totalMinor: quote.total.minor,
      decision: result.body.decision,
      status: result.status,
      problem: result.status >= 400 ? result.body.type : undefined,
      blocked: result.body.blocked,
      purchase: result.requestId,
      state: purchase?.state,
      logIndex: purchase?.logIndex?.toString(),
      evidence: { root: result.evidenceRoot, skipped, ms: result.timings },
      agent: agent && { outcome: agent.outcome, ms: agent.ms, usd: agent.usage.usd },
      checkout: run && {
        outcome: run.outcome,
        ms: run.ms,
        usd: run.usage.usd,
        refusedByGate: gate.refused,
      },
      transactionId,
      recorded,
      alibi: {
        status: alibiRes.status,
        verdict,
        listed: listed.purchases.some((p) => p.id === result.requestId),
      },
    };
    console.log(JSON.stringify(summary));
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Live checkout\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`,
      );
    }
    const ok =
      RUN === "blocked"
        ? summary.decision === "deny" &&
          run?.outcome !== "paid" &&
          gate.refused > 0 &&
          summary.state === "DENIED" &&
          verdict?.startsWith("verified") === true
        : summary.decision === "allow" &&
          run?.outcome === "paid" &&
          recorded === 200 &&
          summary.alibi.status === 200 &&
          summary.alibi.listed;
    if (!ok) process.exitCode = 1;
  } finally {
    await session.close();
  }
} finally {
  await h.close();
}
