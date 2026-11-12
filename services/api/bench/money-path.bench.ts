import { appendFileSync } from "node:fs";
import { accessToken } from "@keelson/agent";
import { cartHash } from "@keelson/core";
import { closeMandate } from "@keelson/mandate";
import { ulid } from "ulid";
import { bytesToHex } from "viem";
import { principalChannel } from "../src/principal.ts";
import { parseServerTiming } from "../src/server-timing.ts";
import { EvidenceUploader } from "../test/evidence.ts";
import { cartOf, demoOperator } from "../test/pipeline-live.ts";
import { SoftwarePasskey, signedMandate } from "../test/tee-live.ts";
import { type Hold, openHold, purchaseEnded, remaining, remote, signIn } from "./public-client.ts";
import { stats, waterfall } from "./waterfall.ts";

// PURCHASES purchases of the demo cart at PRICE_MINOR cents (100) spread over CONCURRENCY fresh
// mandates of the bench account, through Keelson's public API only: the account signs in with its
// passkey (BENCH_PASSKEY) and each mandate is held with its saved PayPal, with no PayPal window.
// The agent is the demo operator's own OAuth client (KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET).
// Each purchase is timed from POST /v1/countersign until the agent's event stream says it ended;
// its steps come from the purchase's Server-Timing. Prints the waterfall as JSON and exits 1 if
// a purchase is not captured or the end-to-end p95 is over budget.
const PURCHASES = Number(process.env.PURCHASES ?? 40);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 1);
const BUDGET_P95_MS = 8_000;
const PRICE_MINOR = Number(process.env.PRICE_MINOR ?? 100);
/** With DURATION_S set, purchases keep starting until it has passed (PURCHASES at most). */
const DURATION_S = Number(process.env.DURATION_S ?? 0);
const TERMINAL_WAIT_MS = 120_000;

const API = process.env.KEELSON_API_URL ?? "https://api.keelson.finance";
const APP = process.env.APP_ORIGIN ?? "https://app.keelson.finance";
const CLIENT_ID = process.env.KEELSON_CLIENT_ID;
const CLIENT_SECRET = process.env.KEELSON_CLIENT_SECRET;
const BENCH_PASSKEY = process.env.BENCH_PASSKEY;
if (!CLIENT_ID || !CLIENT_SECRET || !BENCH_PASSKEY) {
  throw new Error("the bench needs KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET and BENCH_PASSKEY");
}
const stored = JSON.parse(BENCH_PASSKEY) as { credentialId: string; pkcs8: string };
const passkey = SoftwarePasskey.fromPkcs8(stored.credentialId, stored.pkcs8);
const token = accessToken({
  apiUrl: API,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  scopes: ["countersign:write", "evidence:write"],
});
const agent = remote(API, async () => ({ authorization: `Bearer ${await token()}` }));
const evidence = new EvidenceUploader();

interface Result {
  id: string;
  status: number;
  state: string;
  ms: number;
  timings: Record<string, number>;
  failure?: string;
}

const results: Result[] = [];
const holds: Hold[] = [];
/** The last purchase of the demo cart on each mandate: the next one repeats it on purpose. */
const last = new Map<string, string>();

async function purchase(h: Hold, evidenceRoot: string): Promise<Result> {
  const cart = cartOf(PRICE_MINOR);
  const requestId = ulid();
  const channel = principalChannel(
    { kind: "client", subject: CLIENT_ID as string },
    `purchase:${requestId}`,
  );
  const watch = purchaseEnded(agent, channel, TERMINAL_WAIT_MS);
  await watch.ready;
  const repeatOf = last.get(h.mid);
  const body = {
    authorizationId: h.authorizationId,
    closedMandate: await closeMandate(
      h.openMandate,
      { requestId, cartHash: `sha256:${bytesToHex(cartHash(cart.cart)).slice(2)}` },
      h.key,
    ),
    cart: cart.cart,
    unit: cart.unit,
    evidenceRoot,
    ...(repeatOf ? { repeatOf } : {}),
  };
  const started = Date.now();
  const res = await agent.request("/v1/countersign", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": ulid() },
    body: JSON.stringify(body),
  });
  const out = (await res.json()) as Record<string, unknown>;
  if (res.status < 300) {
    last.set(h.mid, requestId);
    await watch.ended;
  }
  const ended = Date.now();
  const read = await agent.request(`/v1/purchases/${requestId}`);
  const view = read.ok
    ? ((await read.json()) as { state: string; failureReason?: string | null })
    : undefined;
  const timings = {
    ...parseServerTiming(res.headers.get("server-timing") ?? ""),
    ...parseServerTiming(read.headers.get("server-timing") ?? ""),
  };
  const state = view?.state ?? (res.status >= 400 ? "ERROR" : "UNKNOWN");
  const failure =
    res.status >= 400 ? String(out.type ?? res.status) : (view?.failureReason ?? undefined);
  return {
    id: requestId,
    status: res.status,
    state,
    ms: ended - started,
    timings,
    ...(failure ? { failure } : {}),
  };
}

const user = await signIn(API, passkey, APP);
try {
  const perHold = Math.ceil(PURCHASES / CONCURRENCY);
  for (let i = 0; i < CONCURRENCY; i++) {
    holds.push(
      await openHold(
        user,
        (sub, edit) => signedMandate(passkey, sub, demoOperator, edit),
        (m) => {
          const max = perHold * PRICE_MINOR;
          m.payment.constraints = m.payment.constraints.map((c) =>
            c.type === "payment.budget" || c.type === "payment.amount_range" ? { ...c, max } : c,
          );
        },
      ),
    );
  }
  // The evidence of every purchase is captured first, one browser page at a time, so the
  // concurrent purchases are not also running a browser page each.
  const roots: string[] = [];
  const cart = cartOf(PRICE_MINOR).cart;
  for (let i = 0; i < PURCHASES; i++) {
    const hold = holds[i % CONCURRENCY] as Hold;
    roots.push(await evidence.upload(agent, hold.mid, cart, {}));
  }
  await evidence.close();

  const until = DURATION_S > 0 ? Date.now() + DURATION_S * 1000 : Number.POSITIVE_INFINITY;
  // Worker w buys on holds[w] alone: purchases w, w + CONCURRENCY, ...
  const worker = async (w: number) => {
    for (let i = w; i < PURCHASES && Date.now() < until; i += CONCURRENCY) {
      const r = await purchase(holds[i % CONCURRENCY] as Hold, roots[i] as string);
      results.push(r);
      console.error(`${results.length}/${PURCHASES} ${r.id} ${r.status} ${r.state} ${r.ms} ms`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, w) => worker(w)));

  const captured = results.filter((r) => r.state === "CAPTURED");
  const failures: Record<string, number> = {};
  for (const r of results.filter((r) => r.state !== "CAPTURED")) {
    const k = `${r.status} ${r.state} ${r.failure ?? ""}`.trim();
    failures[k] = (failures[k] ?? 0) + 1;
  }
  const summary = {
    run: {
      PURCHASES,
      CONCURRENCY,
      PRICE_MINOR,
      DURATION_S,
      api: API,
      commit: process.env.RENDER_GIT_COMMIT,
    },
    endToEnd: stats(captured.map((r) => r.ms)),
    ...waterfall(captured.map((r) => r.timings)),
    // The first purchase pays what a fresh mandate has not opened or loaded yet.
    first: results[0] && waterfall([results[0].timings]),
    purchases: results.length,
    captured: captured.length,
    failures,
    remaining: await Promise.all(holds.map((h) => remaining(user, h.mid))),
    authorizations: holds.map((h) => h.authorizationId),
  };
  console.log(JSON.stringify(summary));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Money path\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`,
    );
  }
  if (
    captured.length === 0 ||
    captured.length < results.length ||
    summary.endToEnd.p95 >= BUDGET_P95_MS
  ) {
    process.exitCode = 1;
  }
} finally {
  for (const h of holds) {
    const revoked = await user.post(`/v1/mandates/${h.mid}/revoke`).catch((err: unknown) => err);
    if (revoked instanceof Error || (revoked as { status: number }).status >= 300) {
      console.error(
        `mandate ${h.mid} not revoked: ${String(revoked instanceof Error ? revoked : JSON.stringify(revoked))}`,
      );
    }
  }
  await evidence.close().catch(() => {});
}
