import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, toHex } from "@keelson/core";
import type { Countersign } from "@keelson/core/eip712";
import { createDb, eq, mandates, teeSigners, user } from "@keelson/db";
import {
  buildManifest,
  disclose,
  type Manifest,
  type SealedItem,
  verifyDisclosure,
} from "@keelson/evidence";
import { type Capture, captureEvidence, startRecorder } from "@keelson/evidence/capture";
import {
  LOG_VKEYS,
  leafBytes,
  leafFromCountersign,
  leafHash,
  paypalRefCommit,
  verifyCheckpoint,
} from "@keelson/log";
import { TSA_INTERMEDIATES, TSA_ROOTS, type TsaId, verifyTimestamp } from "@keelson/timestamp";
import { generateHybridIdentity, identityToRecipient } from "age-encryption";
import { pino } from "pino";
import { chromium } from "playwright";
import { ulid } from "ulid";
import type { Hex } from "viem";
import { hexToBytes } from "viem";
import { routePages } from "../../../packages/evidence/test/server.ts";
import demo from "../../../packages/mandate/test/fixtures/demo-mandate.json" with { type: "json" };
import skus from "../channel3-skus.json" with { type: "json" };
import { createApp } from "../src/app.ts";
import { createChannel3 } from "../src/channel3/client.ts";
import { createKv } from "../src/kv.ts";
import { appendLeaf } from "../src/log/append.ts";
import { LegClient } from "../src/tee/client.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { startStampWorker } from "../src/timestamps/worker.ts";
import {
  asUser,
  carts,
  headerPrincipal,
  registerMandate,
  request,
  SoftwarePasskey,
  seedUser,
  signedMandate,
} from "../test/tee-live.ts";

// Walks one purchase through the deployed log and evidence layer, then a second one with leg B
// unreachable: capture on a KERNEL browser with a Channel3 observation, POST /v1/evidence,
// POST /v1/countersign, the append, the cosigned checkpoint, the RFC 3161 tokens over the leaf
// hash and the observation, and the monitor's audit. Everything after the append is read back
// from the public endpoints. Runs on Render, next to the log's private write listener.
const LOG = "https://log.keelson.finance/alibi/2026-1";
const API = process.env.PUBLIC_API_URL ?? "https://api.keelson.finance";
const MONITOR = process.env.MONITOR_URL ?? "https://keelson-monitor-production.up.railway.app";
const STORE = "https://store.keelson.test";
const ORIGIN = "log.keelson.finance/alibi/2026-1";

for (const k of ["LOG_URL", "LOG_WRITE_TOKEN", "KERNEL_API_KEY", "CHANNEL3_API_KEY"])
  if (!process.env[k]) throw new Error(`${k} is required`);

const since = (t: number) => Math.round(performance.now() - t);
async function until<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean) {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const json = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  return { status: res.status, body: res.ok ? await res.json() : null };
};

function openssl(tsa: TsaId, token: Uint8Array, digest: Uint8Array): boolean {
  const dir = mkdtempSync(join(tmpdir(), "keelson-walk-"));
  writeFileSync(join(dir, "token.der"), token);
  writeFileSync(join(dir, "root.pem"), `${TSA_ROOTS[tsa]}\n`);
  const args = ["ts", "-verify", "-token_in", "-in", join(dir, "token.der")];
  args.push("-digest", Buffer.from(digest).toString("hex"), "-CAfile", join(dir, "root.pem"));
  const intermediate = TSA_INTERMEDIATES[tsa];
  if (intermediate) {
    writeFileSync(join(dir, "untrusted.pem"), `${intermediate}\n`);
    args.push("-untrusted", join(dir, "untrusted.pem"));
  }
  return execFileSync("openssl", args, { encoding: "utf8" }).includes("Verification: OK");
}

/** Waits for two primary (or fallback) tokens over `hash` and checks each in Node and OpenSSL. */
async function stamped(hash: Uint8Array) {
  const hex = Buffer.from(hash).toString("hex");
  const { body } = await until(
    `the tokens over ${hex}`,
    () => json(`${API}/v1/timestamps/${hex}`),
    (r) => r.status === 200 && r.body.pending.length === 0 && r.body.stamps.length >= 2,
  );
  const out: string[] = [];
  for (const s of body.stamps as { tsa: TsaId; token: string }[]) {
    const token = Uint8Array.from(Buffer.from(s.token, "base64"));
    await verifyTimestamp(token, hash);
    out.push(`${s.tsa} ${openssl(s.tsa, token, hash) ? "openssl ok" : "openssl FAILED"}`);
  }
  return out.join(", ");
}

const log = pino({ level: "warn" });
const { db, pool } = createDb(process.env.DATABASE_URL as string);
const kv = await createKv(process.env.REDIS_URL as string, log);
const stamps = startStampWorker({ db, kv, log });
const tlog = { url: process.env.LOG_URL as string, token: process.env.LOG_WRITE_TOKEN as string };
const kernel = (path: string, init?: RequestInit) =>
  fetch(`https://api.onkernel.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.KERNEL_API_KEY}`,
      "content-type": "application/json",
    },
  });
let session: string | undefined;

try {
  const tee = createTee({
    TEE_A_URL: process.env.TEE_A_URL as string,
    TEE_B_URL: process.env.TEE_B_URL as string,
    KEELSON_TEE_TOKEN: process.env.KEELSON_TEE_TOKEN as string,
  });
  await refreshLeg(db, "a", tee);
  await refreshLeg(db, "b", tee);
  const deps = {
    db,
    kv,
    log,
    appOrigin: "https://app.keelson.finance",
    authenticate: headerPrincipal,
    stamps,
    channel3: createChannel3(process.env.CHANNEL3_API_KEY as string),
    requestTimeoutMs: 60_000,
  };
  const apps = {
    "2of2": createApp({ ...deps, tee }),
    // Leg B unreachable the way the live tests make it: its client points at a closed port.
    degraded: createApp({
      ...deps,
      tee: {
        ...tee,
        client: {
          a: tee.client.a,
          b: new LegClient("b", "http://127.0.0.1:9", process.env.KEELSON_TEE_TOKEN as string, 500),
        },
      },
    }),
  };
  const app = apps["2of2"];
  const post = (a: typeof app, path: string, body: unknown, headers: Record<string, string>) =>
    a.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
      body: JSON.stringify(body),
    });

  const passkey = await SoftwarePasskey.create();
  const signed = await signedMandate(passkey);
  await seedUser(db, passkey, signed.sub);
  // The sandbox authorization names the demo mandate, so its row is reused once stored.
  const stored = await post(app, "/v1/mandates", signed.body, asUser(signed.sub));
  if (stored.status !== 201 && stored.status !== 409)
    throw new Error(`mandate not stored: ${stored.status}`);
  const mandateId = demo.mid;
  const agent = await registerMandate(tee.client.a, passkey);
  await db.insert(user).values({ id: agent.sub, name: "Walk", email: `${agent.sub}@example.test` });
  await db
    .update(mandates)
    .set({
      userId: agent.sub,
      openMandate: agent.issued.open_mandate,
      mandateHash: Buffer.from(hexToBytes(agent.issued.mandate_hash)),
    })
    .where(eq(mandates.id, mandateId));
  const asAgent = {
    "x-test-principal": JSON.stringify({
      kind: "client",
      subject: "walk-agent",
      scopes: ["countersign:write", "evidence:write", "evidence:disclose"],
    }),
  };
  const cart = structuredClone(carts.demo);
  for (const line of cart.cart.lines) line.unit_minor = 30;
  cart.unit.amount.value = "0.30";
  cart.unit.amount.breakdown.item_total.value = "0.30";
  const measurement = async (address: Hex | null) => {
    if (address === null) return null;
    const [row] = await db
      .select({ m: teeSigners.measurement })
      .from(teeSigners)
      .where(eq(teeSigners.address, Buffer.from(hexToBytes(address))));
    return row?.m ?? null;
  };
  const recipient = await identityToRecipient(await generateHybridIdentity());
  const sku = skus.find((s) => s.catalog) as { url: string };

  let t = performance.now();
  const created = (await (
    await kernel("/browsers", {
      method: "POST",
      body: JSON.stringify({ headless: true, timeout_seconds: 600 }),
    })
  ).json()) as { session_id: string; cdp_ws_url: string };
  session = created.session_id;
  const browser = await chromium.connectOverCDP(created.cdp_ws_url);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  await routePages(context, STORE);
  console.log(`KERNEL browser: ${since(t)} ms`);

  for (const mode of ["2of2", "degraded"] as const) {
    const steps: [string, number | string][] = [];
    const step = (name: string, v: number | string) => steps.push([name, v]);

    t = performance.now();
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });
    const recorder = await startRecorder(page);
    await page.goto(`${STORE}/product.html`);
    await page.locator("body[data-ready]").waitFor({ state: "attached" });
    const product = await page.evaluate(async () => (await fetch("/api/product.json")).json());
    const llmObservation = await page.locator("body").ariaSnapshot();
    const tc = performance.now();
    const capture: Capture = await captureEvidence(recorder, {
      product,
      cart: cart.cart,
      llmObservation,
      recipient,
    });
    step("capture + manifest on KERNEL", since(tc));
    await recorder.stop();
    await page.close();

    t = performance.now();
    const productItem = capture.items.find((i) => i.type === "api.product");
    if (!productItem) throw new Error("no api.product item");
    const observed = await post(
      app,
      "/v1/observations/channel3",
      { mandateId, url: sku.url, agentView: { contentHash: toHex(sha256(productItem.bytes)) } },
      asAgent,
    );
    if (observed.status !== 201) throw new Error(`observation: ${observed.status}`);
    const obs = (await observed.json()) as {
      status: string;
      item: { salt: string; bytes: string };
    };
    const c3: SealedItem = {
      type: "channel3.observation",
      mediaType: "application/json",
      salt: Uint8Array.from(Buffer.from(obs.item.salt, "base64")),
      bytes: Uint8Array.from(Buffer.from(obs.item.bytes, "base64")),
    };
    step(`Channel3 observation (${obs.status})`, since(t));

    t = performance.now();
    const items = [...capture.items];
    const at = items.findIndex((i) => i.type.endsWith(".original"));
    items.splice(at < 0 ? items.length : at, 0, c3);
    const manifest = buildManifest(items);
    const ev = await post(
      app,
      "/v1/evidence",
      {
        mandateId,
        manifest,
        items: items.map((i) => ({
          type: i.type,
          mediaType: i.mediaType,
          salt: Buffer.from(i.salt).toString("base64"),
          bytes: Buffer.from(i.bytes).toString("base64"),
        })),
      },
      asAgent,
    );
    if (ev.status !== 201) throw new Error(`evidence: ${ev.status} ${await ev.text()}`);
    const { evidenceRoot } = (await ev.json()) as { evidenceRoot: Hex };
    step("POST /v1/evidence", since(t));

    t = performance.now();
    const r = await request(agent, cart, ulid());
    const res = await post(
      apps[mode],
      "/v1/countersign",
      {
        authorizationId: r.authorization_id,
        closedMandate: r.closed_mandate,
        cart: r.cart,
        unit: r.unit,
        evidenceRoot,
      },
      asAgent,
    );
    const out = (await res.json()) as {
      purchaseId: string;
      mode: "2of2" | "degraded";
      countersign: Record<string, string>;
      digest: Hex;
      signatures: { tdx: Hex; nitro: Hex | null };
      signers: { tdx: Hex; nitro: Hex | null };
    };
    if (res.status !== 200 || out.mode !== mode)
      throw new Error(`countersign: ${res.status} ${JSON.stringify(out)}`);
    step(`POST /v1/countersign (${out.mode})`, since(t));
    const countersigned = performance.now();

    const c = out.countersign;
    const message: Countersign = {
      requestId: c.requestId as Hex,
      mandateHash: c.mandateHash as Hex,
      mandateCommitment: c.mandateCommitment as Hex,
      cartHash: c.cartHash as Hex,
      agentId: BigInt(c.agentId as string),
      merchantId: c.merchantId as Hex,
      amount: BigInt(c.amount as string),
      currency: Number(c.currency),
      category: Number(c.category),
      evidenceRoot: c.evidenceRoot as Hex,
      evalHash: c.evalHash as Hex,
      policySetHash: c.policySetHash as Hex,
      decision: Number(c.decision),
      failedFieldsMask: Number(c.failedFieldsMask),
      issuedAt: Number(c.issuedAt),
      expiresAt: Number(c.expiresAt),
    };
    const leaf = leafBytes(
      leafFromCountersign(
        message,
        out.digest,
        out.mode,
        out.signatures,
        {
          tdx: (await measurement(out.signers.tdx)) as string,
          nitro: await measurement(out.signers.nitro),
        },
        paypalRefCommit(randomBytes(32), `WALK${out.purchaseId}`, r.authorization_id ?? ""),
      ),
    );
    t = performance.now();
    const appended = await appendLeaf({ db, tlog, log, stamps }, out.purchaseId, leaf, c);
    step(`append, leaf ${appended.index} (${leaf.length} B)`, since(t));

    const covering = await until(
      "a public checkpoint covering the leaf",
      async () => (await fetch(`${LOG}/checkpoint`, { cache: "no-store" })).text(),
      (note) => Number(note.split("\n")[1]) > appended.index,
    );
    const verified = verifyCheckpoint(covering, LOG_VKEYS[ORIGIN] as readonly string[]);
    const cosigners = [...covering.matchAll(/^— (witness-\d\.keelson\.finance) /gm)].map(
      (m) => m[1],
    );
    step(
      `countersign → public checkpoint size ${verified.size}, cosigned by ${cosigners.join(" + ")}`,
      since(countersigned),
    );
    if (new Set(cosigners).size < 2) throw new Error("fewer than two own cosignatures");

    t = performance.now();
    const manifestRes = await json(`${API}/v1/evidence/${evidenceRoot}`);
    const publicManifest = manifestRes.body as Manifest;
    if (publicManifest.root !== evidenceRoot) throw new Error("public manifest root differs");
    const k = items.findIndex((i) => i.type === "channel3.observation");
    const disclosed = await apps[mode].request(
      `/v1/evidence/${evidenceRoot}/items/${k}?reason=walk`,
      { headers: asAgent },
    );
    const d = (await disclosed.json()) as {
      disclosure: Parameters<typeof verifyDisclosure>[1];
      bytes: string;
    };
    const ok =
      verifyDisclosure(evidenceRoot, d.disclosure, Buffer.from(d.bytes, "base64")) &&
      verifyDisclosure(evidenceRoot, disclose(items, k));
    step(`public manifest + disclosed item ${k} verifies: ${ok}`, since(t));

    t = performance.now();
    step(`leaf tokens: ${await stamped(leafHash(leaf))}`, since(countersigned));
    step(`Channel3 tokens: ${await stamped(sha256(c3.bytes))}`, since(t));

    const report = await until(
      "the monitor's audit of the leaf",
      async () => (await json(`${MONITOR}/report`)).body,
      (rep) => {
        const o = rep?.origins?.find((x: { origin: string }) => x.origin === ORIGIN);
        return (
          o &&
          o.leavesAudited > appended.index &&
          (mode === "2of2" || o.degradedLeaves.includes(appended.index))
        );
      },
    );
    const o = report.origins.find((x: { origin: string }) => x.origin === ORIGIN);
    step(
      `countersign → monitor audited (${o.leavesAudited} leaves, ${o.degradedCount} degraded, ${o.findings.length} findings)`,
      since(countersigned),
    );

    console.log(`\n## ${mode}: purchase ${out.purchaseId}, leaf ${appended.index}`);
    console.log(`leaf hash ${toHex(leafHash(leaf))}, evidence root ${evidenceRoot}`);
    console.log(`Channel3 content hash ${toHex(sha256(c3.bytes))}`);
    for (const [name, v] of steps) console.log(`| ${name} | ${v} ms |`);
  }
  await browser.close();
} finally {
  if (session) await kernel(`/browsers/${session}`, { method: "DELETE" });
  await stamps.stop();
  await pool.end();
  await kv.close();
}
