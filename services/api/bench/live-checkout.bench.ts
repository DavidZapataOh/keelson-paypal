// Loads reflect-metadata before anything pulls in @keelson/attest (see tee/attest.ts).
import "../src/tee/attest.ts";
import { appendFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  ALFRED,
  apiClient,
  checkout,
  decimal,
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
  shopifyCart,
} from "@keelson/agent";
import { decodeAlibi } from "@keelson/alibi";
import { verifyAlibi } from "@keelson/alibi/verify";
import type { CheckoutTotal, FxReference } from "@keelson/core";
import { startRecorder } from "@keelson/evidence/capture";
import { maxSpreadBps, parseMandate } from "@keelson/mandate";
import { demoOperator } from "../test/pipeline-live.ts";
import { SoftwarePasskey, signedMandate } from "../test/tee-live.ts";
import { type Hold, openHold, revokeMandate, signIn } from "./public-client.ts";

// The shopping agent at a real store, with real money, under a fresh mandate for one digital
// copy of the live item from Alfred Music (at most $5). The buyer's PayPal session is the KERNEL
// profile PAYPAL_PROFILE, which the buyer signed in to himself. Run as a one-off job of
// keelson-api, like the money-path bench, through Keelson's public API only: the bench account
// signs in with its passkey (BENCH_PASSKEY) and holds the mandate with its saved PayPal, and the
// agent calls the API as the operator's OAuth client (KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET).
//
//   LIVE_RUN=blocked  a cart that breaks the mandate (two copies, over the budget): Keelson denies
//                     it, and the agent's checkout is held at its first payment action.
//   LIVE_RUN=buy      the guarded agent finds the item and proposes it; Keelson countersigns it;
//                     the agent pays at the store's checkout with PayPal; the purchase's Alibi
//                     gets the PayPal transaction id and is published. Needs LIVE_BUY=yes. When
//                     the checkout adds tax or shipping once PayPal has the buyer's address, the
//                     run re-quotes it and asks Keelson to countersign the new total, which must
//                     also fit the mandate: the first countersign holds its amount until it
//                     expires, so the mandate leaves room for both.
//
// Prints a JSON summary, with no URL query, page text or credential, and exits 1 unless the run
// ends as it should.
const RUN = process.env.LIVE_RUN;
if (RUN !== "blocked" && (RUN !== "buy" || process.env.LIVE_BUY !== "yes")) {
  throw new Error("LIVE_RUN=blocked, or LIVE_RUN=buy with LIVE_BUY=yes");
}
const PROFILE = process.env.PAYPAL_PROFILE ?? "keelson-live-paypal";
// Two copies ($5.90) break a $5 mandate; one copy and its re-quote with tax fit an $8 one.
const MAX_MINOR = RUN === "blocked" ? 500 : 800;
/** No live purchase may cost more, whatever the mandate says. */
const CEILING_MINOR = 1_500;
const SETTLE_MS = 180_000;
const productUrl = `${ALFRED.origin}${LIVE_ITEM.path}`;

const recipient = process.env.KEELSON_EVIDENCE_AGE_RECIPIENT as string;
if (!recipient) throw new Error("needs KEELSON_EVIDENCE_AGE_RECIPIENT");
const client = new Anthropic();
const API_URL = process.env.KEELSON_API_URL ?? "https://api.keelson.finance";
const APP_ORIGIN = process.env.APP_ORIGIN ?? "https://app.keelson.finance";
const stored = JSON.parse(process.env.BENCH_PASSKEY ?? "null") as {
  credentialId: string;
  pkcs8: string;
} | null;
if (!stored) throw new Error("needs BENCH_PASSKEY");
const passkey = SoftwarePasskey.fromPkcs8(stored.credentialId, stored.pkcs8);
const user = await signIn(API_URL, passkey, APP_ORIGIN);
const agentApi = apiClient({
  apiUrl: API_URL,
  clientId: process.env.KEELSON_CLIENT_ID as string,
  clientSecret: process.env.KEELSON_CLIENT_SECRET as string,
  scopes: ["countersign:write", "evidence:write"],
});

/** The purchase once it ended: failed, or logged or denied with its Alibi issued. */
async function settle(id: string) {
  const until = Date.now() + SETTLE_MS;
  for (;;) {
    const res = await user.api.request(`/v1/purchases/${id}`);
    const p = res.ok
      ? ((await res.json()) as { state: string; logIndex?: string | null })
      : undefined;
    const issued =
      p && (p.state === "LOGGED" || p.state === "DENIED")
        ? (await user.api.request(`/v1/alibis/${id}`)).ok
        : false;
    if ((p && (p.state === "FAILED" || issued)) || Date.now() > until) return p;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

const log = (s: { at: number; kind: string; detail: string }) =>
  console.error(`+${s.at}ms ${s.kind} ${s.detail.slice(0, 160)}`);

let held: Hold | undefined;
try {
  let mandate: unknown;
  const hold: Hold = await openHold(
    user,
    (sub, edit) => signedMandate(passkey, sub, demoOperator, edit),
    (m) => {
      liveMandate(m, MAX_MINOR, process.env.ALFRED_PAYPAL_MERCHANT_ID ?? "unknown");
      mandate = structuredClone(m);
    },
  );
  held = hold;
  const session = await openSession({ hosts: ALFRED.hosts, profile: PROFILE, locale: "en-US" });
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
    if (quote.total.minor > CEILING_MINOR) {
      throw new Error(`the cart costs ${decimal(quote.total.currency, quote.total.minor)}`);
    }
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
    const gate = new PayGate({
      checkoutHosts: ALFRED.checkoutHosts,
      cart: shopifyCart(session.context, ALFRED.origin),
      maxSpreadBps: maxSpreadBps(parseMandate(structuredClone(mandate))),
      ...(process.env.ALFRED_PAYPAL_MERCHANT_ID
        ? { payee: process.env.ALFRED_PAYPAL_MERCHANT_ID }
        : {}),
    });
    if (allowed) gate.allow(quote.total, result.reference);
    // The purchase the payment is for: the first countersign, or the last re-quote Keelson allowed.
    let paid = result.requestId;
    const requotes: Record<string, unknown>[] = [];
    // A re-quoted total is countersigned on evidence captured in a tab of its own on the product
    // page, so nothing of the checkout's pages, which show the buyer's address, is sealed.
    const requote = async (
      total: CheckoutTotal,
    ): Promise<{ allowed: boolean; reference?: FxReference }> => {
      if (total.minor > CEILING_MINOR) return { allowed: false };
      const tab = await session.context.newPage();
      const recorder = await startRecorder(tab);
      try {
        await tab.goto(productUrl);
        await tab.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        const next = { ...quote, total };
        const again = await checkout({
          keelson: agentApi,
          headers: {},
          hold: {
            mandateId: hold.mid,
            openMandate: hold.openMandate,
            agentKey: hold.key,
            authorizationId: hold.authorizationId,
          },
          session: { ...session, page: tab, recorder },
          quote: next,
          observation: agent ? agent.reads.join("\n\n") : "",
          recipient,
          observe: liveObservations({
            keelson: agentApi,
            headers: {},
            mandateId: hold.mid,
            productUrl,
            quote: next,
            skipped,
          }),
          live: { store: ALFRED.origin },
          repeatOf: paid,
        });
        const ok = again.status < 300 && again.body.decision === "allow";
        requotes.push({
          total,
          purchase: again.requestId,
          status: again.status,
          decision: again.body.decision,
          problem: again.status >= 400 ? again.body.type : undefined,
        });
        if (ok) paid = again.requestId;
        return { allowed: ok, ...(again.reference ? { reference: again.reference } : {}) };
      } finally {
        await recorder.stop().catch(() => {});
        await tab.close();
      }
    };

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
          requote,
          onStep: log,
        })
      : undefined;
    const purchase = await settle(paid);
    let transactionId: string | undefined;
    let recorded: number | undefined;
    if (run?.outcome === "paid") {
      transactionId = await paypalTransactionId(
        session.context,
        session.page,
        decimal(run.total.currency, run.total.minor),
        "Alfred",
      );
      if (transactionId) {
        const res = await agentApi.request(`/v1/purchases/${paid}/paypal-transaction`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            transactionId,
            ...(gate.paid
              ? {
                  order: { intent: gate.paid.charge.intent, payee: gate.paid.charge.payee },
                  ...(gate.paid.conversion ? { conversion: gate.paid.conversion } : {}),
                }
              : {}),
          }),
        });
        recorded = res.status;
      }
    }
    const alibiRes = await fetch(`${API_URL}/v1/alibis/${paid}`);
    // A live Alibi is public once its transaction is recorded; its owner reads it before that.
    const own = alibiRes.status === 200 ? alibiRes : await user.api.request(`/v1/alibis/${paid}`);
    const bundle = own.ok ? decodeAlibi(new Uint8Array(await own.arrayBuffer())) : undefined;
    const verdict = bundle ? (await verifyAlibi(bundle)).verdict : undefined;
    const listed = (await (await fetch(`${API_URL}/v1/live-purchases`)).json()) as {
      purchases: { id: string }[];
    };

    const summary = {
      run: RUN,
      store: ALFRED.origin,
      mandate: hold.mid,
      cart: quote.cart.lines.map((l) => `${l.qty}x ${l.sku} @ ${l.unit_minor}`),
      total: run?.total ?? quote.total,
      decision: result.body.decision,
      status: result.status,
      problem: result.status >= 400 ? result.body.type : undefined,
      blocked: result.body.blocked,
      purchase: paid,
      requotes,
      state: purchase?.state,
      logIndex: purchase?.logIndex ?? undefined,
      evidence: { root: result.evidenceRoot, skipped, ms: result.timings },
      agent: agent && { outcome: agent.outcome, ms: agent.ms, usd: agent.usage.usd },
      checkout: run && {
        outcome: run.outcome,
        ms: run.ms,
        usd: run.usage.usd,
        refusedByGate: gate.refused,
        // PayPal's order and its conversion, as the gate let the payment through.
        paypalOrder: gate.paid?.charge && {
          intent: gate.paid.charge.intent,
          value: `${gate.paid.charge.currency} ${gate.paid.charge.value}`,
          payee: gate.paid.charge.payee,
        },
        conversion: gate.paid?.conversion,
        // Only the amounts read on each page where a pay action was held.
        heldAmounts: gate.held,
      },
      transactionId,
      recorded,
      alibi: {
        status: alibiRes.status,
        verdict,
        listed: listed.purchases.some((p) => p.id === paid),
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
  // As every run does: the mandate's sandbox hold is released.
  if (held) {
    await revokeMandate(user, held.mid).catch((err: unknown) => console.error(String(err)));
  }
}
