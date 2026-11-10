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

const MARK = html`<svg class="mark" viewBox="0 0 28 20" aria-hidden="true"><path d="M2 18 10 2h6L8 18zM13 18l8-16h6l-8 16z" /></svg>`;

function layout(o: { title: string; description: string; body: Html; head?: Html }) {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${o.description}" />
    <meta name="theme-color" content="#16181b" />
    <title>${o.title}</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="preload" href="/fonts/barlow-condensed-700.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="stylesheet" href="/store.css" />
    ${o.head ?? ""}
  </head>
  <body>
    <header class="top">
      <a class="brand" href="/">${MARK}<span>${BRAND}</span></a>
      <nav aria-label="Shop">
        <a href="/#road">Road</a><a href="/#trail">Trail</a><a href="/#race">Race</a>
      </nav>
    </header>
    <main>${o.body}</main>
    <footer class="site">
      <p><strong>${BRAND}</strong> is the demo merchant of Keelson. Purchases an AI agent makes here are checked against the buyer's signed mandate before PayPal captures them.</p>
      <p>Checkout runs on the PayPal sandbox: the payment is real, the money is not.</p>
    </footer>
  </body>
</html>`;
}

/** A side-view running shoe in the product's paint, toe to the right. */
function shoe(p: Product, label: string | null = `${p.title}, side view, ${p.color}`): Html {
  const { upper, sole, accent } = p.paint;
  const a11y = label === null ? html`aria-hidden="true"` : html`role="img" aria-label="${label}"`;
  return html`<svg class="shoe" viewBox="0 0 640 340" ${a11y}>
  <ellipse cx="330" cy="304" rx="262" ry="9" fill="#16181b" opacity=".14" />
  <path d="M60 224c-6 26-4 46 8 58 10 9 24 12 40 12h402c38 0 66-14 84-38 4-7 1-12-8-12l-170-6c-90-3-170-6-250-12-42-3-74-6-106-2z" fill="${sole}" />
  <path d="M68 282c10 9 24 12 40 12h402c38 0 66-14 84-38l6 6c-18 30-48 46-90 46H106c-22 0-36-8-44-22z" fill="#16181b" />
  <path d="M60 228C52 190 54 150 66 122c4-10 14-14 26-12 28 6 54 16 80 16 26 0 44-12 62-26 14-10 32-8 44 2l94 66c48 28 102 20 152 28 42 8 68 26 72 46 1 8-4 12-12 12l-164-14c-90-2-170-4-250-10-50-4-84-8-110-2z" fill="${upper}" />
  <path d="M92 110c28 6 54 16 80 16 26 0 44-12 62-26-18 8-36 12-60 12-26 0-54-6-76-12-6 0-10 4-6 10z" fill="#16181b" opacity=".85" />
  <path d="M62 132c-6-16-2-28 8-30 8 0 12 8 14 20z" fill="${accent}" />
  <path d="M500 198c48 4 84 22 94 42 2 10-4 14-12 12-26-6-54-14-86-18z" fill="#16181b" opacity=".16" />
  <path d="M150 206c110-6 210-10 320-2l-4 10c-106-8-204-4-314 2z" fill="${accent}" />
  <path d="M248 106l124 80" stroke="#16181b" stroke-width="16" stroke-linecap="round" opacity=".12" />
  <path d="M262 112l-6 16M286 127l-6 16M310 142l-6 16M334 157l-6 16M358 172l-6 16" stroke="#f4f3ef" stroke-width="5" stroke-linecap="round" />
</svg>`;
}

const ANCHOR: Record<Product["terrain"], string> = {
  Road: "road",
  Trail: "trail",
  Race: "race",
  "Race kit": "race",
};

export function catalogPage() {
  const groups = (["Road", "Trail", "Race"] as const).map((t) => ({
    terrain: t,
    products: PRODUCTS.filter((p) => ANCHOR[p.terrain] === t.toLowerCase()),
  }));
  return layout({
    title: `${BRAND} | Running shoes for road, trail and race day`,
    description: `${BRAND} running shoes for road, trail and race day.`,
    body: html`<section class="intro">
  <h1>Shoes for every mile of the course</h1>
  <p>Seven pairs, from easy road miles to race day. Pick a size and pay with PayPal. Checkout runs on the PayPal sandbox, so no money moves and nothing ships.</p>
</section>
${groups.map(
  (
    g,
  ) => html`<section class="leg" id="${g.terrain.toLowerCase()}" aria-labelledby="leg-${g.terrain.toLowerCase()}">
  <h2 id="leg-${g.terrain.toLowerCase()}" class="sign">${g.terrain}</h2>
  <ul class="grid">
    ${g.products.map(
      (p) => html`<li>
      <a class="tile" href="/products/${p.handle}">
        <span class="stage">${shoe(p, null)}</span>
        <span class="tile-name">${p.title}</span>
        <span class="tile-meta">${p.terrain} · ${p.color}</span>
        <span class="tile-price">${display(p.priceMinor)}</span>
      </a>
    </li>`,
    )}
  </ul>
</section>`,
)}`,
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
  const figureLabel = at(injections, "aria-label")[0];
  return layout({
    title: `${p.title} | ${BRAND}`,
    description: p.description,
    head: html`<script type="application/ld+json">${raw(scriptJson(ld))}</script>
    <script defer nonce="${o.nonce}" src="${PAYPAL_SDK[o.environment]}"></script>
    <script type="module" nonce="${o.nonce}" src="/checkout.js"></script>`,
    body: html`<article class="pdp">
  <figure class="pdp-stage">${shoe(p, figureLabel)}</figure>
  <section class="course" data-checkout data-client-id="${o.clientId}" data-handle="${p.handle}">
    <h1>${p.title}</h1>
    <p class="price"><span>${display(p.priceMinor)}</span> ${CURRENCY}</p>
    <p class="specs">${p.terrain} · <span class="cap">${p.color}</span> · US men's sizes</p>
    <p class="description">${p.description}</p>
    ${at(injections, "description").map((t) => html`<p>${t}</p>`)}
    ${hidden("opacity: 0", at(injections, "opacity"))}
    ${hidden("position: absolute; left: -9999px", at(injections, "offscreen"))}
    ${hidden("color: #ffffff; background: #ffffff", at(injections, "color"))}
    ${hidden("font-size: 0.5px", at(injections, "tiny"))}
    <ol class="route">
      <li class="marker" data-step="size">
        <span class="mile" aria-hidden="true">1</span>
        <fieldset>
          <legend>Size</legend>
          <div class="sizes">
            ${p.sizes.map(
              (s) =>
                html`<label class="size"><input type="radio" name="size" value="${s}" aria-label="US ${s}" /><span>${s}</span></label>`,
            )}
          </div>
        </fieldset>
      </li>
      <li class="marker" data-step="pay">
        <span class="mile" aria-hidden="true">2</span>
        <div class="pay">
          <h2>Pay</h2>
          <paypal-button type="pay" hidden></paypal-button>
          <p class="status" role="status">Loading PayPal…</p>
        </div>
      </li>
      <li class="marker" data-step="finish">
        <span class="mile" aria-hidden="true">3</span>
        <div>
          <h2>Finish</h2>
          <p>PayPal captures the payment and your receipt opens here. Demo store: nothing ships.</p>
        </div>
      </li>
    </ol>
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
  const name = order.payer?.name?.givenName;
  return layout({
    title: `Order ${order.id} | ${BRAND}`,
    description: `${BRAND} order ${order.id}`,
    body: paid
      ? html`<article class="finish">
  <ol class="route-done" aria-label="Checkout complete">
    <li><span class="mile" aria-hidden="true">1</span><span>Size</span></li>
    <li><span class="mile" aria-hidden="true">2</span><span>Pay</span></li>
    <li class="arch"><span class="mile" aria-hidden="true">3</span><span>Finish</span></li>
  </ol>
  <header class="finish-head">
    <h1>Order confirmed</h1>
    <p>${name ? `Thank you, ${name}. ` : "Thank you. "}PayPal captured your payment. This is a demo store, so nothing ships.</p>
  </header>
  <dl class="bibs">
    <div class="bib"><dt>Order</dt><dd>${order.id}</dd></div>
    <div class="bib"><dt>PayPal transaction</dt><dd>${capture?.id}</dd></div>
  </dl>
  <div class="finish-body">
    <ul class="lines">
      ${(unit?.items ?? []).map(
        (i) =>
          html`<li><span>${i.quantity} × ${i.name}</span><span class="sku">${i.sku}</span><span class="amount">$${i.unitAmount.value}</span></li>`,
      )}
    </ul>
    <dl class="receipt">
      <dt class="total">Total</dt><dd class="total">$${capture?.amount?.value} ${capture?.amount?.currencyCode}</dd>
    </dl>
  </div>
  <p><a class="back" href="/">Back to the shoes</a></p>
</article>`
      : html`<article class="finish">
  <h1>Payment pending</h1>
  <p>Order ${order.id} has not been paid. <a href="/">Back to the shoes</a></p>
</article>`,
  });
}

export function notFoundPage() {
  return layout({
    title: `Not found | ${BRAND}`,
    description: "Page not found",
    body: html`<article class="finish"><h1>Off course</h1><p>That page is not here. <a href="/">See all shoes</a></p></article>`,
  });
}
