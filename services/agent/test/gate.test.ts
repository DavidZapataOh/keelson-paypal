import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { checkoutTotal } from "@keelson/core";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { StoreBrowser } from "../src/driver.ts";
import { PayGate } from "../src/gate.ts";
import { checkoutDetails, reference } from "./fixtures/paypal-pages.ts";

const USD_295 = checkoutTotal("USD", { items: 295 });
const TOKEN = "0TEST000000000295";

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
  // PayPal's review page for a buyer whose account converts to COP, written as PayPal writes
  // amounts in Latin American Spanish: "$2.95 USD" with a point, "$10.231 COP" grouped with one.
  // A test buyer only: every name, address and number in it is made up.
  "/pay/converted": page(
    `<header><button aria-label="Ver carrito">$2.95 USD</button></header>
    <h1>Revisar pedido</h1>
    <section aria-label="Resumen del pedido" data-testid="cart-summary">
      <div><span>The Change</span> <span>$2.95 USD</span></div>
      <div><span>Envío</span> <span>$0.00 USD</span></div>
      <div data-testid="cart-total"><span>Total</span> <span>$2.95 USD</span></div>
    </section>
    <section aria-label="Pagar con">
      <p>Ana Prueba · ana.prueba@example.test</p>
      <p>Calle 85 # 11-53, Bogotá</p>
      <div><span>Saldo de PayPal</span> <span>$1.669 COP</span></div>
      <div><span>Visa ••••</span> <span>4242</span></div>
      <p>Tasa de conversión de PayPal: 1 USD = 3.468,14 COP</p>
      <div><span>Pagarás</span> <span>$10.231 COP</span></div>
      <a href="#">Ver opciones de conversión</a>
    </section>
    <button>Pagar ahora</button>`,
    "es",
  ),
  // The same page with the total only in COP: what the gate read on the held run (1669, 10231,
  // 10231, 0, 1, 0, 1 and "$2.95 USD" unread) under the reader that took "$" for USD.
  "/pay/cop-total": page(
    `<h1>Revisar pedido</h1>
    <div><span>The Change</span> <span>$2.95 USD</span></div>
    <div><span>Saldo de PayPal</span> <span>$1.669 COP</span></div>
    <div><span>Subtotal</span> <span>$10.231 COP</span></div>
    <div><span>Total</span> <span>$10.231 COP</span></div>
    <p>Envío $0 COP · 1 USD = 3.468,14 COP</p>
    <p>Impuestos $0 COP · 1 USD = 3.468,14 COP</p>
    <p>CC 1.023.456.789 · +57 300 123 4567</p>
    <button>Pagar ahora</button>`,
    "es",
  ),
  // A bare "$" amount on a page that also names COP may be either currency.
  "/pay/bare": page(
    `<h1>Revisar pedido</h1><div><span>Total</span> <span>$2.95 USD</span></div>
    <div><span>Pagarás</span> <span>$10.231</span></div><p>1 USD = 3.468,14 COP</p>
    <button>Pagar ahora</button>`,
    "es",
  ),
  "/checkouts/cn/framed": page(
    `<p>Item $2.95 USD</p><iframe srcdoc="<p>Total $5.90 USD</p>"></iframe><button>Pay now</button>`,
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
  /** The pages served here as PayPal's host: every action on them is gated. */
  const asPayPal = async () => {
    await driver.close();
    gate = new PayGate({ checkoutHosts: ["127.0.0.1"], convertHosts: ["127.0.0.1"] });
    driver = await StoreBrowser.attach(context, tab, { hosts: ["127.0.0.1"], gate });
  };
  const click = (target: Record<string, unknown>) =>
    driver.toolResult(call("left_click", { target }));
  const out = () => tab.locator("#out").textContent();

  beforeAll(async () => {
    server = createServer((req, res) => {
      // PayPal's GraphQL: the order every page served as PayPal's is for.
      if (req.method === "POST" && req.url?.startsWith("/graphql")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(checkoutDetails({ value: "2.95" })));
        return;
      }
      const body = PAGES[new URL(req.url ?? "", "http://x").pathname];
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
    gate.allow(USD_295);
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
    gate.allow(USD_295);
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
    gate.allow(USD_295);
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
    gate.allow(USD_295);
    await open("/checkouts/cn/two");
    const r = await click({ type: "ref", ref: await ref("Pay now") });
    expect(r.is_error).toBe(true);
    expect(await out()).toBe("");
  });

  test("a total written the Spanish way passes; a larger one is refused and its amounts kept", async () => {
    gate.allow(USD_295);
    await open("/checkouts/cn/es");
    const paid = await click({ type: "ref", ref: await ref("Pagar ahora") });
    expect(paid.is_error, JSON.stringify(gate.held)).toBeFalsy();
    expect(await out()).toBe("clicked Pagar ahora");
    await open("/checkouts/cn/es-tax");
    const held = await click({ type: "ref", ref: await ref("Pagar ahora") });
    expect(held.is_error).toBe(true);
    expect(text(held)).toMatch(/now USD 3\.13/);
    expect(gate.held).toMatchObject([
      {
        locale: "es",
        amounts: ["USD 2.95", "USD 0.18", "USD 3.13"],
        totals: ["USD 3.13"],
        requote: "USD 3.13",
      },
    ]);
  });

  test("a total with tax is re-quoted, and paid only once Keelson countersigned it", async () => {
    gate.allow(USD_295);
    await open("/checkouts/cn/es-tax");
    expect((await click({ type: "ref", ref: await ref("Pagar ahora") })).is_error).toBe(true);
    const next = gate.takeRequote();
    expect(next).toEqual(checkoutTotal("USD", { items: 295, tax: 18 }));
    expect(gate.takeRequote()).toBeUndefined();
    // Until it is countersigned, the higher total stays held.
    expect((await click({ type: "ref", ref: await ref("Pagar ahora") })).is_error).toBe(true);
    gate.allow(next as NonNullable<typeof next>);
    expect((await click({ type: "ref", ref: await ref("Pagar ahora") })).is_error).toBeFalsy();
    expect(await out()).toBe("clicked Pagar ahora");
    // A page showing less than the countersigned total is not it either.
    await open("/checkouts/cn/es");
    expect((await click({ type: "ref", ref: await ref("Pagar ahora") })).is_error).toBe(true);
  });

  test("a larger total nobody labels as tax or shipping is held and not re-quoted", async () => {
    gate.allow(USD_295);
    await open("/checkouts/cn/two");
    expect((await click({ type: "ref", ref: await ref("Pay now") })).is_error).toBe(true);
    expect(gate.takeRequote()).toBeUndefined();
  });

  test("a page that names no locale is held, even showing the total", async () => {
    gate.allow(USD_295);
    await open("/checkouts/cn/nolang");
    expect((await click({ type: "ref", ref: await ref("Pay now") })).is_error).toBe(true);
    expect(gate.held).toMatchObject([{ locale: null, amounts: [], unsure: "no locale" }]);
  });

  test("the store's own cart must hold the countersigned total too", async () => {
    await driver.close();
    let cart = { currency: "USD", minor: 590 };
    gate = new PayGate({ checkoutHosts: [], cart: async () => cart });
    driver = await StoreBrowser.attach(context, tab, { hosts: ["127.0.0.1"], gate });
    gate.allow(USD_295);
    await open("/checkouts/cn/abc");
    expect((await click({ type: "ref", ref: await ref("Pay now") })).is_error).toBe(true);
    expect(gate.held[0]?.cart).toBe("USD 5.90");
    cart = { currency: "USD", minor: 295 };
    expect((await click({ type: "ref", ref: await ref("Pay now") })).is_error).toBeFalsy();
  });

  test("the store's cart holds the items before tax; a cart that changed is never re-quoted", async () => {
    await driver.close();
    let cart = { currency: "USD", minor: 295 };
    gate = new PayGate({ checkoutHosts: [], cart: async () => cart });
    driver = await StoreBrowser.attach(context, tab, { hosts: ["127.0.0.1"], gate });
    gate.allow(checkoutTotal("USD", { items: 295, tax: 18 }));
    await open("/checkouts/cn/es-tax");
    expect((await click({ type: "ref", ref: await ref("Pagar ahora") })).is_error).toBeFalsy();
    gate.allow(USD_295);
    cart = { currency: "USD", minor: 590 };
    expect((await click({ type: "ref", ref: await ref("Pagar ahora") })).is_error).toBe(true);
    expect(gate.takeRequote()).toBeUndefined();
  });

  test("PayPal's page with the total in USD and its conversion to COP is paid", async () => {
    await asPayPal();
    gate.allow(USD_295, reference());
    await open(`/pay/converted?token=${TOKEN}`);
    // With no conversion from PayPal's own answers, the page is read again in English, once.
    const first = await click({ type: "ref", ref: await ref("Pagar ahora") });
    expect(text(first)).toMatch(/switched PayPal's page to English/);
    expect(new URL(tab.url()).searchParams.get("locale.x")).toBe("en_US");
    const r = await click({ type: "ref", ref: await ref("Pagar ahora") });
    expect(r.is_error, JSON.stringify(gate.held)).toBeFalsy();
    expect(await out()).toBe("clicked Pagar ahora");
    expect(gate.paid).toMatchObject({
      charge: { intent: "SALE", currency: "USD", value: "2.95" },
      conversion: { buyer: { currency: "COP", value: "10231" }, rate: "3468.14", spread_bps: 500 },
    });
  });

  test("PayPal's page with a number that may be a larger amount is held, and the log keeps no buyer data", async () => {
    await asPayPal();
    gate.allow(USD_295, reference());
    await open(`/pay/cop-total?token=${TOKEN}`);
    await click({ type: "ref", ref: await ref("Pagar ahora") });
    const r = await click({ type: "ref", ref: await ref("Pagar ahora") });
    expect(r.is_error).toBe(true);
    expect(text(r)).toMatch(/a larger amount that may be charged/);
    expect(await out()).toBe("");
    const [held] = gate.held;
    // "1 USD = 3.468,14 COP" is a rate, not an amount.
    expect(held).toMatchObject({ locale: "es", amounts: ["USD 2.95"] });
    expect(held?.totals).toEqual([]);
    const log = JSON.stringify(gate.held);
    for (const secret of ["023", "456", "789", "300", "4567"]) expect(log).not.toContain(secret);
    expect(held?.seen).toEqual(
      expect.arrayContaining([
        { amount: "$10.231 COP", kind: "other", context: "total", label: "Total", region: "" },
        {
          amount: "$1.669 COP",
          kind: "other",
          context: "aside",
          label: "Saldo de PayPal",
          region: "",
        },
        { amount: "3.468,14 COP", kind: "other", context: "line", label: "=", region: "" },
        expect.objectContaining({ amount: "#.###.###.###", kind: "loose", label: "▪" }),
        expect.objectContaining({ amount: "## ### ### ####", kind: "loose" }),
      ]),
    );
  });

  test("on PayPal's page, the log keeps amounts, checkout words and regions only", async () => {
    await asPayPal();
    gate.allow(checkoutTotal("USD", { items: 100 }));
    await open(`/pay/converted?token=${TOKEN}`);
    expect((await click({ type: "ref", ref: await ref("Pagar ahora") })).is_error).toBe(true);
    const log = JSON.stringify(gate.held);
    for (const secret of ["Ana", "Prueba", "example", "Calle", "85", "53", "Bogot", "4242"]) {
      expect(log).not.toContain(secret);
    }
    expect(gate.held[0]?.seen).toEqual(
      expect.arrayContaining([
        {
          amount: "$2.95 USD",
          kind: "target",
          context: "total",
          label: "Total",
          region: "section cart-total",
        },
        {
          amount: "$10.231 COP",
          kind: "other",
          context: "total",
          label: "Pagarás",
          region: "section",
        },
        {
          amount: "$1.669 COP",
          kind: "other",
          context: "aside",
          label: "Saldo de PayPal",
          region: "section",
        },
      ]),
    );
  });

  test("a bare dollar amount on a page that names COP may be USD, so a larger one holds", async () => {
    await asPayPal();
    gate.allow(USD_295);
    await open(`/pay/bare?token=${TOKEN}`);
    expect((await click({ type: "ref", ref: await ref("Pagar ahora") })).is_error).toBe(true);
  });

  test("a larger total inside a frame is seen", async () => {
    gate.allow(USD_295);
    await open("/checkouts/cn/framed");
    expect((await click({ type: "ref", ref: await ref("Pay now") })).is_error).toBe(true);
    expect(gate.held[0]?.amounts).toContain("USD 5.90");
  });
});
