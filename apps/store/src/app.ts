import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { type PayPal, type PayPalEnv, PayPalError } from "@keelson/paypal";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { routePath } from "hono/route";
import { NONCE, type SecureHeadersVariables, secureHeaders } from "hono/secure-headers";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import { z } from "zod";
import { display, PRODUCTS, product, productJson, QuoteError, quote } from "./catalog.ts";
import { deleteListing, getListing, ListingRequest, putListing } from "./listings.ts";
import { captureOrder, createOrder, storeOrder } from "./orders.ts";
import { catalogPage, notFoundPage, orderPage, productPage } from "./pages.ts";
import { type PlatformDeps, registerPlatform } from "./platform.ts";

export interface StoreDeps {
  paypal: PayPal;
  /** Public by design: the JS SDK authenticates with the client ID alone. */
  clientId: string;
  environment: PayPalEnv;
  kv: RedisClientType;
  /** The bearer token of the red team's listing calls. */
  attackToken: string;
  /** The store's public origin, e.g. `https://store.keelson.finance`. */
  origin: string;
  log: Logger;
  /** The demo agent platform that embeds Keelson's approval; not served without it. */
  platform?: Omit<PlatformDeps, "kv" | "log">;
}

const PAYPAL = ["https://*.paypal.com", "https://*.paypalobjects.com", "https://*.venmo.com"];

const ASSETS: Record<string, { file: URL; type: string }> = {
  "/store.css": {
    file: new URL("../public/store.css", import.meta.url),
    type: "text/css; charset=utf-8",
  },
  "/checkout.js": {
    file: new URL("../public/checkout.js", import.meta.url),
    type: "text/javascript; charset=utf-8",
  },
  "/favicon.svg": {
    file: new URL("../public/favicon.svg", import.meta.url),
    type: "image/svg+xml",
  },
  "/fonts/barlow-400.woff2": {
    file: new URL(import.meta.resolve("@fontsource/barlow/files/barlow-latin-400-normal.woff2")),
    type: "font/woff2",
  },
  "/fonts/barlow-600.woff2": {
    file: new URL(import.meta.resolve("@fontsource/barlow/files/barlow-latin-600-normal.woff2")),
    type: "font/woff2",
  },
  "/fonts/barlow-condensed-700.woff2": {
    file: new URL(
      import.meta.resolve(
        "@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff2",
      ),
    ),
    type: "font/woff2",
  },
};

const CartRequest = z.strictObject({
  lines: z
    .array(z.strictObject({ handle: z.string().max(64), size: z.string().max(8), qty: z.int() }))
    .max(16),
});

function problem(c: Context, status: 401 | 404 | 422 | 500 | 502, title: string, detail?: string) {
  return c.newResponse(
    JSON.stringify({
      type: "about:blank",
      title,
      status,
      ...(detail ? { detail } : {}),
      instance: c.req.path,
    }),
    status,
    { "content-type": "application/problem+json" },
  );
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export function createApp(deps: StoreDeps): Hono<{ Variables: SecureHeadersVariables }> {
  const app = new Hono<{ Variables: SecureHeadersVariables }>();
  const assets = Object.fromEntries(
    Object.entries(ASSETS).map(([path, { file }]) => [path, readFileSync(file)]),
  );
  const tokenDigest = digest(deps.attackToken);
  const authorized = (c: Context) => {
    const given = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    return given !== undefined && timingSafeEqual(digest(given), tokenDigest);
  };
  const body = async <T extends z.ZodType>(c: Context, schema: T) =>
    schema.safeParse(await c.req.json().catch(() => undefined));

  app.use(async (c, next) => {
    const start = performance.now();
    await next();
    deps.log.info(
      {
        method: c.req.method,
        route: routePath(c, -1),
        status: c.res.status,
        ms: Math.round(performance.now() - start),
      },
      "request",
    );
  });
  if (deps.platform) registerPlatform(app, { ...deps.platform, kv: deps.kv, log: deps.log });
  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", NONCE, ...PAYPAL],
        styleSrc: ["'self'", "'unsafe-inline'", ...PAYPAL],
        imgSrc: ["'self'", "data:", ...PAYPAL],
        connectSrc: ["'self'", ...PAYPAL],
        frameSrc: PAYPAL,
        childSrc: PAYPAL,
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      // PayPal's checkout window reports back to this page through its opener.
      crossOriginOpenerPolicy: "same-origin-allow-popups",
    }),
  );
  app.use("/api/*", bodyLimit({ maxSize: 32 * 1024 }));

  app.get("/health", (c) => c.text("ok"));
  for (const [path, { type }] of Object.entries(ASSETS)) {
    app.get(path, (c) =>
      c.body(assets[path] as Uint8Array<ArrayBuffer>, 200, {
        "content-type": type,
        "cache-control": `public, max-age=${path.startsWith("/fonts/") ? 31_536_000 : 300}`,
      }),
    );
  }

  app.get("/", (c) => c.html(catalogPage()));
  app.get("/products/:handle", (c) => {
    const p = product(c.req.param("handle"));
    if (!p) return c.notFound();
    return c.html(
      productPage({
        product: p,
        url: `${deps.origin}/products/${p.handle}`,
        clientId: deps.clientId,
        environment: deps.environment,
        nonce: c.get("secureHeadersNonce") as string,
      }),
    );
  });
  app.get("/l/:id", async (c) => {
    const listing = await getListing(deps.kv, c.req.param("id"));
    const p = listing && product(listing.product);
    if (!listing || !p) return c.notFound();
    return c.html(
      productPage({
        product: p,
        url: `${deps.origin}/l/${listing.id}`,
        clientId: deps.clientId,
        environment: deps.environment,
        nonce: c.get("secureHeadersNonce") as string,
        injections: listing.injections,
      }),
    );
  });
  app.get("/orders/:id", async (c) => {
    const order = await storeOrder(deps.paypal, c.req.param("id"));
    return order ? c.html(orderPage(order)) : c.notFound();
  });
  // Where PayPal sends the buyer back when the SDK fell back to a full-page redirect.
  app.get("/checkout/return", async (c) => {
    const id = c.req.query("token") ?? "";
    const result = await captureOrder(deps.paypal, id);
    return result.kind === "not-found" ? c.notFound() : c.redirect(`/orders/${id}`, 303);
  });

  app.get("/api/products", (c) =>
    c.json(PRODUCTS.map((p) => productJson(p, `${deps.origin}/products/${p.handle}`))),
  );
  app.get("/api/products/:handle", (c) => {
    const p = product(c.req.param("handle"));
    return p ? c.json(productJson(p, `${deps.origin}/products/${p.handle}`)) : c.notFound();
  });

  const quoted = async (c: Context) => {
    const parsed = await body(c, CartRequest);
    if (!parsed.success) return problem(c, 422, "Invalid cart", z.prettifyError(parsed.error));
    try {
      return quote(parsed.data.lines);
    } catch (e) {
      if (e instanceof QuoteError) return problem(c, 422, "Invalid cart", e.message);
      throw e;
    }
  };
  app.post("/api/cart", async (c) => {
    const q = await quoted(c);
    if (q instanceof Response) return q;
    const minor = Number(q.total.minor);
    return c.json({
      cart: q.cart,
      total: { currency: q.total.currency, minor, display: display(minor) },
    });
  });
  app.post("/api/orders", async (c) => {
    const q = await quoted(c);
    if (q instanceof Response) return q;
    const order = await createOrder(deps.paypal, q, deps.origin);
    return c.json({ id: order.id }, 201);
  });
  app.post("/api/orders/:id/capture", async (c) => {
    const result = await captureOrder(deps.paypal, c.req.param("id"));
    if (result.kind === "not-found") return problem(c, 404, "Not found");
    if (result.kind === "not-approved") {
      return problem(c, 422, "Order not approved", "The buyer has not approved this order.");
    }
    const capture = result.order.purchaseUnits?.[0]?.payments?.captures?.[0];
    return c.json({ id: result.order.id, status: result.order.status, captureId: capture?.id });
  });

  app.post("/api/listings", async (c) => {
    if (!authorized(c)) return problem(c, 401, "Unauthorized");
    const parsed = await body(c, ListingRequest);
    if (!parsed.success) return problem(c, 422, "Invalid listing", z.prettifyError(parsed.error));
    if (!product(parsed.data.product)) {
      return problem(c, 422, "Invalid listing", `There is no product "${parsed.data.product}".`);
    }
    const listing = await putListing(deps.kv, parsed.data);
    return c.json(
      { id: listing.id, url: `${deps.origin}/l/${listing.id}`, expiresAt: listing.expiresAt },
      201,
    );
  });
  app.get("/api/listings/:id", async (c) => {
    const listing = await getListing(deps.kv, c.req.param("id"));
    const p = listing && product(listing.product);
    if (!listing || !p) return problem(c, 404, "Not found");
    const extra = listing.injections.filter((i) => i.placement === "api").map((i) => i.text);
    return c.json({
      id: listing.id,
      expiresAt: listing.expiresAt,
      product: productJson(
        p,
        `${deps.origin}/l/${listing.id}`,
        [p.description, ...extra].join(" "),
      ),
    });
  });
  app.delete("/api/listings/:id", async (c) => {
    if (!authorized(c)) return problem(c, 401, "Unauthorized");
    return (await deleteListing(deps.kv, c.req.param("id")))
      ? c.body(null, 204)
      : problem(c, 404, "Not found");
  });

  app.notFound((c) =>
    c.req.path.startsWith("/api/") ? problem(c, 404, "Not found") : c.html(notFoundPage(), 404),
  );
  app.onError((err, c) => {
    deps.log.error({ err, route: routePath(c, -1) }, "request failed");
    return problem(
      c,
      err instanceof PayPalError ? 502 : 500,
      "The store could not complete the request",
    );
  });
  return app;
}
