import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { StoreBrowser } from "../src/driver.ts";
import { PayGate } from "../src/gate.ts";

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

const page = (body: string, lang = "en") =>
  `<!doctype html><html lang="${lang}"><body>${body}<p id="out"></p><script>for (const b of document.querySelectorAll("button")) b.onclick = () => { document.getElementById("out").textContent = "clicked " + b.textContent; };</script></body></html>`;

const PAGES: Record<string, string> = {
  "/products/the-change": page("<h1>The Change</h1><p>$2.95</p><button>Add to cart</button>"),
  "/checkouts/cn/abc": page("<h1>Checkout</h1><p>Total $2.95 USD</p><button>Pay now</button>"),
  "/checkouts/cn/save": page(
    '<p>Total $2.95 USD</p><label><input type="checkbox" id="s"> Save PayPal for future purchases</label><label><input type="checkbox" id="k" checked> Remember me</label>',
  ),
  "/checkouts/cn/two": page(
    "<p>The Change $2.95</p><p>Total $5.90 USD</p><button><span>Pay</span> now</button>",
  ),
  "/checkouts/cn/icon": page(
    '<p>Total $2.95 USD</p><button aria-label="x"><span id="icon">&#10148;</span> Pay now</button>',
  ),
  "/checkouts/cn/es": page(
    "<h1>Revisar pedido</h1><p>Total 2,95\u00a0US$</p><button>Pagar ahora</button>",
    "es",
  ),
  "/checkouts/cn/es-tax": page(
    "<p>The Change US$2,95</p><p>Impuestos US$0,18</p><p>Total US$3,13</p><button>Pagar ahora</button>",
    "es",
  ),
  "/checkouts/cn/nolang": page("<p>Total $2.95 USD</p><button>Pay now</button>", ""),
  "/checkouts/cn/more": page("<h1>Checkout</h1><p>Total $4.99 USD</p><button>Pay now</button>"),
  "/checkouts/cn/frame": page(
    `<h1>Checkout</h1><p>Total $2.95 USD</p><iframe srcdoc='${page("<button>Complete Purchase</button>").replaceAll("'", "&#39;")}'></iframe>`,
  ),
};

describe("the pay-click gate", () => {
  let chrome: Browser;
  let server: Server;
  let origin: string;
  let context: BrowserContext;
  let tab: Page;
  let gate: PayGate;
  let driver: StoreBrowser;

  const ref = async (name: string) => {
    const tree = text(await driver.toolResult(call("read_page", {})));
    const line = tree.split("\n").find((l) => l.includes(`button "${name}"`));
    const found = /\[(ref_(?:f\d+)?e\d+)\]/.exec(line ?? "")?.[1];
    if (!found) throw new Error(`no ${name} in ${tree}`);
    return found;
  };
  const open = async (path: string) => {
    const r = await driver.toolResult(call("navigate", { url: `${origin}${path}` }));
    expect(r.is_error).toBeFalsy();
  };
  const click = (target: Record<string, unknown>) =>
    driver.toolResult(call("left_click", { target }));
  const out = () => tab.locator("#out").textContent();

  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = PAGES[req.url ?? ""];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(body ?? "");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    chrome = await chromium.launch();
    context = await chrome.newContext({ viewport: { width: 1280, height: 800 } });
  });
  beforeEach(async () => {
    await driver?.close();
    await tab?.close();
    tab = await context.newPage();
    gate = new PayGate({ checkoutHosts: ["www.paypal.com"] });
    driver = await StoreBrowser.attach(context, tab, { hosts: ["127.0.0.1"], gate });
  });
  afterAll(async () => {
    await driver?.close();
    await chrome?.close();
    await new Promise((r) => server.close(r));
  });

  test("browsing and adding to the cart are never held", async () => {
    await open("/products/the-change");
    const r = await click({ type: "ref", ref: await ref("Add to cart") });
    expect(r.is_error).toBeFalsy();
    expect(await out()).toBe("clicked Add to cart");
  });

  test("before the countersignature, the pay click is refused and never reaches the page", async () => {
    await open("/checkouts/cn/abc");
    const r = await click({ type: "ref", ref: await ref("Pay now") });
    expect(r.is_error).toBe(true);
    expect(text(r)).toMatch(/countersign/i);
    expect(await out()).toBe("");
    expect(gate.refused).toBe(1);
  });

  test("a pay button inside a frame is held too", async () => {
    await open("/checkouts/cn/frame");
    const r = await click({ type: "ref", ref: await ref("Complete Purchase") });
    expect(r.is_error).toBe(true);
  });

  test("on a checkout page, clicks by coordinate and the Enter key are refused before it", async () => {
    await open("/checkouts/cn/abc");
    expect((await click({ type: "coordinate", x: 30, y: 120 })).is_error).toBe(true);
    expect((await driver.toolResult(call("key", { text: "Enter" }))).is_error).toBe(true);
    expect((await driver.toolResult(call("type", { text: "x\n" }))).is_error).toBe(true);
    expect(await out()).toBe("");
  });

  test("after it, the pay click goes through only where the page shows the countersigned total", async () => {
    gate.allow({ minor: 295, currency: "USD" });
    await open("/checkouts/cn/more");
    const r = await click({ type: "ref", ref: await ref("Pay now") });
    expect(r.is_error).toBe(true);
    expect(text(r)).toMatch(/2\.95/);
    expect(await out()).toBe("");
    await open("/checkouts/cn/abc");
    const ok = await click({ type: "ref", ref: await ref("Pay now") });
    expect(ok.is_error).toBeFalsy();
    expect(await out()).toBe("clicked Pay now");
  });

  test("on a checkout host, every action waits, whatever it is named", async () => {
    await driver.close();
    gate = new PayGate({ checkoutHosts: ["127.0.0.1"] });
    driver = await StoreBrowser.attach(context, tab, { hosts: ["127.0.0.1"], gate });
    await open("/products/the-change");
    expect((await click({ type: "ref", ref: await ref("Add to cart") })).is_error).toBe(true);
    expect(await out()).toBe("");
  });

  test("saving a payment method is refused even after the countersignature; unchecking is not", async () => {
    gate.allow({ minor: 295, currency: "USD" });
    await open("/checkouts/cn/save");
    const tree = text(await driver.toolResult(call("read_page", {})));
    const box = (label: string) =>
      /\[(ref_e\d+)\]/.exec(tree.split("\n").find((l) => l.includes(label)) ?? "")?.[1] as string;
    const save = await click({ type: "ref", ref: box("Save PayPal") });
    expect(save.is_error).toBe(true);
    expect(text(save)).toMatch(/never saves/);
    expect(await tab.locator("#s").isChecked()).toBe(false);
    expect((await click({ type: "ref", ref: box("Remember me") })).is_error).toBeFalsy();
    expect(await tab.locator("#k").isChecked()).toBe(false);
  });

  test("Space or any key on a checkout page is refused, so a focused pay button cannot be pressed", async () => {
    gate.allow({ minor: 295, currency: "USD" });
    await open("/checkouts/cn/abc");
    for (const text of ["Tab", "space", "NumpadEnter"]) {
      expect((await driver.toolResult(call("key", { text }))).is_error).toBe(true);
    }
    expect((await driver.toolResult(call("type", { text: " " }))).is_error).toBe(true);
    expect(await out()).toBe("");
  });

  test("a click on a pay button's unnamed child is held like the button", async () => {
    await open("/checkouts/cn/icon");
    const tree = text(await driver.toolResult(call("read_page", {})));
    const refs = [...tree.matchAll(/\[(ref_e\d+)\]/g)].map((m) => m[1] as string);
    for (const r of refs) {
      const res = await click({ type: "ref", ref: r });
      expect(res.is_error).toBe(true);
    }
    expect(await out()).toBe("");
  });

  test("a page whose largest amount is more than the countersigned total is refused", async () => {
    gate.allow({ minor: 295, currency: "USD" });
    await open("/checkouts/cn/two");
    const r = await click({ type: "ref", ref: await ref("Pay now") });
    expect(r.is_error).toBe(true);
    expect(await out()).toBe("");
  });

  test("a total written the Spanish way passes; a larger one is refused and its amounts kept", async () => {
    gate.allow({ minor: 295, currency: "USD" });
    await open("/checkouts/cn/es");
    const paid = await click({ type: "ref", ref: await ref("Pagar ahora") });
    expect(paid.is_error, JSON.stringify(gate.held)).toBeFalsy();
    expect(await out()).toBe("clicked Pagar ahora");
    await open("/checkouts/cn/es-tax");
    expect((await click({ type: "ref", ref: await ref("Pagar ahora") })).is_error).toBe(true);
    expect(gate.held).toEqual([{ locale: "es", amounts: ["USD 2.95", "USD 0.18", "USD 3.13"] }]);
  });

  test("a page that names no locale is held, even showing the total", async () => {
    gate.allow({ minor: 295, currency: "USD" });
    await open("/checkouts/cn/nolang");
    expect((await click({ type: "ref", ref: await ref("Pay now") })).is_error).toBe(true);
    expect(gate.held).toEqual([{ locale: null, amounts: [], unsure: "no locale" }]);
  });

  test("the store's own cart must hold the countersigned total too", async () => {
    await driver.close();
    let cart = { currency: "USD", minor: 590 };
    gate = new PayGate({ checkoutHosts: [], cart: async () => cart });
    driver = await StoreBrowser.attach(context, tab, { hosts: ["127.0.0.1"], gate });
    gate.allow({ minor: 295, currency: "USD" });
    await open("/checkouts/cn/abc");
    expect((await click({ type: "ref", ref: await ref("Pay now") })).is_error).toBe(true);
    expect(gate.held[0]?.cart).toBe("USD 5.90");
    cart = { currency: "USD", minor: 295 };
    expect((await click({ type: "ref", ref: await ref("Pay now") })).is_error).toBeFalsy();
  });
});
