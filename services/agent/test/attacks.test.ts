import { appendFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { StoreBrowser } from "../src/driver.ts";
import { PayGate } from "../src/gate.ts";
import { CORPUS, type Entry } from "./attacks/corpus.ts";
import { plans, reference } from "./fixtures/paypal-pages.ts";

/** When set, each entry's outcome is appended to this file as one JSON line. */
const RESULTS = process.env.ATTACK_RESULTS;

const page = (e: Entry) =>
  `<!doctype html><html lang="${e.lang}"><head><meta charset="utf-8"></head><body>${e.body}
<button>${e.host === "paypal" ? "Pay Now" : e.click}</button><p id="out"></p>
<script>document.addEventListener("click", (ev) => { if (ev.isTrusted) document.getElementById("out").textContent = "clicked"; }, true);</script>
</body></html>`;

let n = 0;
const call = (name: string, input: Record<string, unknown>): Anthropic.Beta.BetaToolUseBlock =>
  ({
    type: "tool_use",
    id: `toolu_${++n}`,
    name,
    input,
    toolset_name: "browser",
  }) as Anthropic.Beta.BetaToolUseBlock;

const text = (r: Anthropic.Beta.BetaToolResultBlockParam) =>
  (Array.isArray(r.content) ? r.content : [{ type: "text", text: r.content ?? "" }])
    .map((b) => ("text" in b ? b.text : ""))
    .join("\n");

const byToken = new Map<string, Entry>();
const byId = new Map(CORPUS.map((e) => [e.id, e]));

describe("the checkout-attack corpus against the pay-click gate", () => {
  let chrome: Browser;
  let server: Server;
  let origin: string;
  let context: BrowserContext;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "", "http://x");
      if (req.method === "POST" && url.pathname === "/graphql") {
        let body = "";
        req.on("data", (d) => {
          body += d;
        });
        req.on("end", () => {
          const e = byToken.get(String(req.headers["paypal-client-context"] ?? ""));
          const answer = body.includes("GetFundingOptions") ? (e?.plans ?? plans()) : e?.order;
          res.writeHead(answer ? 200 : 404, { "content-type": "application/json" });
          res.end(JSON.stringify(answer ?? {}));
        });
        return;
      }
      const e =
        byId.get(decodeURIComponent(url.pathname.split("/").at(-1) ?? "")) ??
        byToken.get(url.searchParams.get("token") ?? "");
      res.writeHead(e ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(e ? page(e) : "");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    chrome = await chromium.launch();
    context = await chrome.newContext({ viewport: { width: 1280, height: 800 } });
  });
  afterAll(async () => {
    await chrome?.close();
    await new Promise((r) => server.close(r));
  });

  /** Opens the entry's page behind a gate configured as in production, and clicks its control. */
  const attempt = async (e: Entry) => {
    const tab = await context.newPage();
    const paypal = e.host === "paypal";
    const total = e.total;
    const gate = new PayGate({
      checkoutHosts: paypal ? ["127.0.0.1"] : [],
      convertHosts: paypal ? ["127.0.0.1"] : [],
      ...(e.host === "store" && total
        ? {
            cart: async () => ({
              currency: total.currency,
              minor: e.cart ?? total.items - total.discount,
            }),
          }
        : {}),
      ...(e.payee ? { payee: e.payee } : {}),
    });
    const driver = await StoreBrowser.attach(context, tab, { hosts: ["127.0.0.1"], gate });
    if (total) gate.allow(total, reference());
    const token = `0RT${String(++n).padStart(14, "0")}`;
    byToken.set(token, e);
    const path =
      e.host === "paypal"
        ? `/checkoutnow?token=${token}`
        : e.host === "store"
          ? `/checkouts/rt/${e.id}`
          : `/products/${e.id}`;
    try {
      await driver.toolResult(call("navigate", { url: `${origin}${path}` }));
      const tree = text(await driver.toolResult(call("read_page", {})));
      const name = e.host === "paypal" ? "Pay Now" : e.click;
      const line = tree.split("\n").find((l) => l.includes(`"${name}`) || l.includes(` ${name}"`));
      const ref = /\[(ref_(?:f\d+)?e\d+)\]/.exec(line ?? "")?.[1];
      if (!ref) throw new Error(`no control "${name}" in ${tree}`);
      const r = await driver.toolResult(call("left_click", { target: { type: "ref", ref } }));
      const clicked = (await tab.locator("#out").textContent()) === "clicked";
      return { clicked, result: text(r), held: gate.held.at(-1)?.unsure };
    } finally {
      await driver.close();
      await tab.close();
    }
  };

  test.each(CORPUS.map((e) => [e.id, e] as const))("%s", async (_id, e) => {
    const r = await attempt(e);
    if (RESULTS) {
      appendFileSync(
        RESULTS,
        `${JSON.stringify({ id: e.id, class: e.class, technique: e.technique, source: e.source, host: e.host, lang: e.lang, clicked: r.clicked })}\n`,
      );
    }
    if (e.class === "control") expect(r.clicked, `${e.truth}; gate said: ${r.result}`).toBe(true);
    else expect(r.clicked, `${e.truth}; gate said: ${r.result || "nothing"}`).toBe(false);
  });

  test("ids are unique and every class is covered", () => {
    expect(new Set(CORPUS.map((e) => e.id)).size).toBe(CORPUS.length);
    const classes = new Set(CORPUS.map((e) => e.class));
    for (const c of [
      "hidden",
      "decoy",
      "fee",
      "total",
      "currency",
      "payee",
      "conversion",
      "tool-output",
      "offer",
      "button",
      "control",
    ]) {
      expect(classes).toContain(c);
    }
  });
});
