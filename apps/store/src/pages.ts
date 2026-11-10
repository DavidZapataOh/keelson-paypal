import type { Order } from "@paypal/paypal-server-sdk";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { BRAND, CURRENCY, display, PRODUCTS, type Product } from "./catalog.ts";
import { at, type Injection } from "./listings.ts";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const PAYPAL_SDK = {
  sandbox: "https://www.sandbox.paypal.com/web-sdk/v6/core",
  production: "https://www.paypal.com/web-sdk/v6/core",
} as const;

/** JSON for a `<script>` block: `<`, U+2028 and U+2029 escaped so text cannot close the element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

function layout(o: { title: string; description: string; body: Html; head?: Html }) {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${o.description}" />
    <title>${o.title}</title>
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="/store.css" />
    ${o.head ?? ""}
  </head>
  <body>
    <header class="top">
      <a class="brand" href="/">${BRAND}</a>
      <nav><a href="/">Shoes</a><a href="/products/premium-bundle">Bundles</a></nav>
    </header>
    <main>${o.body}</main>
    <footer>${BRAND} runs on the PayPal sandbox: checkout is real, money is not.</footer>
  </body>
</html>`;
}

/** A side-view running shoe in the product's color. */
function shoe(p: Product): Html {
  return html`<svg class="shoe" viewBox="0 0 320 200" role="img" aria-label="${p.title}, side view, in ${p.color}">
  <rect width="320" height="200" fill="#f1efea" />
  <path d="M40 132c0-20 10-46 30-58 14-8 30-4 40 6 14 14 34 22 58 24 30 2 62 8 84 20 18 10 30 18 30 30v8H40z" fill="${p.hex}" />
  <path d="M40 148h242c8 0 14 6 14 12H52c-8 0-12-6-12-12z" fill="#2b2b2b" />
  <path d="M96 92l14 14M112 86l14 14M128 84l14 14" stroke="#fff" stroke-width="5" stroke-linecap="round" />
</svg>`;
}

export function catalogPage() {
  return layout({
    title: `${BRAND} | Running shoes`,
    description: `${BRAND} running shoes for road, trail and race day.`,
    body: html`<h1>Running shoes</h1>
<ul class="grid">
  ${PRODUCTS.map(
    (p) => html`<li>
    <a class="card" href="/products/${p.handle}">
      ${shoe(p)}
      <span class="name">${p.title}</span>
      <span class="price">${display(p.priceMinor)}</span>
    </a>
  </li>`,
  )}
</ul>`,
  });
}

export interface ProductPageOptions {
  product: Product;
  /** The page's own URL: the product's, or the listing's. */
  url: string;
  clientId: string;
  environment: keyof typeof PAYPAL_SDK;
  nonce: string;
  injections?: readonly Injection[];
}

export function productPage(o: ProductPageOptions) {
  const p = o.product;
  const injections = o.injections ?? [];
  const ld = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.title,
    sku: p.sku,
    description: [p.description, ...at(injections, "json-ld")].join(" "),
    color: p.color,
    brand: { "@type": "Brand", name: BRAND },
    offers: {
      "@type": "Offer",
      url: o.url,
      price: (p.priceMinor / 100).toFixed(2),
      priceCurrency: CURRENCY,
      availability: "https://schema.org/InStock",
      seller: { "@type": "Organization", name: BRAND },
    },
  };
  const hidden = (style: string, texts: string[]) =>
    texts.map((t) => html`<p style="${style}">${t}</p>`);
  const ratingLabel = at(injections, "aria-label")[0];
  return layout({
    title: `${p.title} | ${BRAND}`,
    description: p.description,
    head: html`<script type="application/ld+json">${raw(scriptJson(ld))}</script>
    <script defer nonce="${o.nonce}" src="${PAYPAL_SDK[o.environment]}"></script>
    <script type="module" nonce="${o.nonce}" src="/checkout.js"></script>`,
    body: html`<article class="product">
  ${shoe(p)}
  <section>
    <h1>${p.title}</h1>
    <p class="price">${display(p.priceMinor)}</p>
    <p class="rating"><span class="stars" role="img" aria-label="${ratingLabel ?? "4.8 out of 5 stars"}">&#9733;&#9733;&#9733;&#9733;&#9733;</span> 4.8 from 212 reviews</p>
    <p class="description">${p.description}</p>
    ${at(injections, "description").map((t) => html`<p>${t}</p>`)}
    ${hidden("opacity: 0", at(injections, "opacity"))}
    ${hidden("position: absolute; left: -9999px", at(injections, "offscreen"))}
    ${hidden("color: #ffffff; background: #ffffff", at(injections, "color"))}
    ${hidden("font-size: 0.5px", at(injections, "tiny"))}
    <div class="buy" data-checkout data-client-id="${o.clientId}" data-handle="${p.handle}">
      <label for="size">Size</label>
      <select id="size">
        ${p.sizes.map((s) => html`<option value="${s}"${s === "10" ? " selected" : ""}>US ${s}</option>`)}
      </select>
      <paypal-button type="pay" hidden></paypal-button>
      <p class="status" role="status"></p>
    </div>
    <p class="returns">Free returns within 30 days.</p>
    ${at(injections, "review").map(
      (t) => html`<blockquote class="review">
      <p>${t}</p>
      <footer>Verified buyer</footer>
    </blockquote>`,
    )}
  </section>
</article>`,
  });
}

export function orderPage(order: Order) {
  const unit = order.purchaseUnits?.[0];
  const capture = unit?.payments?.captures?.[0];
  const paid = order.status === "COMPLETED" && capture?.status === "COMPLETED";
  return layout({
    title: `Order ${order.id} | ${BRAND}`,
    description: `${BRAND} order ${order.id}`,
    body: paid
      ? html`<h1>Order confirmed</h1>
<p>Thank you${order.payer?.name?.givenName ? `, ${order.payer.name.givenName}` : ""}. Your shoes ship within two business days.</p>
<dl class="receipt">
  <dt>Order</dt><dd>${order.id}</dd>
  <dt>PayPal transaction</dt><dd>${capture?.id}</dd>
  <dt>Total</dt><dd>$${capture?.amount?.value} ${capture?.amount?.currencyCode}</dd>
</dl>
<ul class="lines">
  ${(unit?.items ?? []).map((i) => html`<li>${i.quantity} × ${i.name} (${i.sku})</li>`)}
</ul>`
      : html`<h1>Payment pending</h1>
<p>Order ${order.id} has not been paid. <a href="/">Back to the shoes</a></p>`,
  });
}

export function notFoundPage() {
  return layout({
    title: `Not found | ${BRAND}`,
    description: "Page not found",
    body: html`<h1>Not found</h1><p>That page is not here. <a href="/">See all shoes</a></p>`,
  });
}
