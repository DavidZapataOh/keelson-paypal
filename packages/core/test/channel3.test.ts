// Fixtures are real Channel3 `POST /v1/lookup` responses captured on 2026-11-07 (UTC dates in each
// file's `captured_at`) with `services/api/scripts/channel3-capture.ts`.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type AgentView,
  type Channel3Product,
  channel3PriceMinor,
  channel3Sources,
  compareChannel3,
  normalizeProduct,
  observationDocument,
} from "../src/channel3.ts";
import { jcs } from "../src/jcs.ts";

interface Fixture {
  captured_at: string;
  url: string;
  http_status: number;
  body_b64: string;
}

const dir = new URL("./fixtures/channel3/", import.meta.url);
const fixtures = Object.fromEntries(
  readdirSync(dir).map((name) => {
    const f = JSON.parse(readFileSync(new URL(name, dir), "utf8")) as Fixture;
    const body = JSON.parse(Buffer.from(f.body_b64, "base64").toString("utf8"));
    return [name.replace(/\.json$/, ""), { ...f, product: body.product as unknown }];
  }),
);

/** Prices read by hand from each fixture's offers, in cents. */
const handRead: Record<string, Record<string, string>> = {
  "shopwss-com": {
    "zumiez.com": "1799",
    "shoepalace.com": "1998",
    "shopwss.com": "2000",
    "next.us": "4000",
    "adidas.com": "1900",
  },
  "allbirds-com": { "allbirds.com": "10000" },
  "jolyn-com": { "jolyn.com": "795" },
  "zumiez-com": { "zumiez.com": "1999" },
};

const contentHash = `0x${"ab".repeat(32)}` as const;

/** The view an agent on the fixture's own URL would have read if it agreed with Channel3. */
function agreeingView(url: string, p: Channel3Product): AgentView {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const offer = p.offers.find((o) => o.domain === host);
  if (!offer) throw new Error(`no offer on ${host}`);
  return {
    contentHash,
    url,
    ...(p.brand ? { brand: p.brand } : {}),
    priceMinor: offer.priceMinor,
    currency: "USD",
    available: offer.availability === "InStock",
    selected: p.selected.map((s) => ({ ...s })),
  };
}

const names = Object.keys(handRead);

describe("channel3 fixtures", () => {
  it("covers every captured fixture", () => {
    expect(Object.keys(fixtures).sort()).toEqual([...names].sort());
    for (const f of Object.values(fixtures)) expect(f.http_status).toBe(200);
  });

  it.each(names)("%s: prices are the hand-read minor units", (name) => {
    const p = normalizeProduct(fixtures[name]?.product);
    expect(Object.fromEntries(p.offers.map((o) => [o.domain, o.priceMinor]))).toEqual(
      handRead[name],
    );
  });

  it.each(names)("%s: the agreeing view matches on every compared field", (name) => {
    const f = fixtures[name] as Fixture & { product: unknown };
    const p = normalizeProduct(f.product);
    const c = compareChannel3(agreeingView(f.url, p), p);
    expect(c.price).toBe("match");
    expect(c.availability).toBe("match");
    expect(c.brand).toBe("match");
    // A product without a selected option has nothing to compare the agent's variant against.
    expect(c.variant).toBe(p.selected.length > 0 ? "match" : "unknown");
    expect(c.mismatches).toEqual([]);
    expect(c.offerDomain).toBe(new URL(f.url).hostname.replace(/^www\./, ""));
  });

  describe.each(["shopwss-com", "jolyn-com"])("%s: one changed field", (name) => {
    const f = fixtures[name] as Fixture & { product: unknown };
    const p = normalizeProduct(f.product);
    const base = agreeingView(f.url, p);
    const only = (view: AgentView, field: string) => {
      const c = compareChannel3(view, p);
      expect(c.mismatches).toEqual([field]);
      expect(c[field as "variant"]).toBe("mismatch");
    };

    it("variant label", () => {
      const [first, ...rest] = base.selected;
      only(
        { ...base, selected: [{ name: first?.name ?? "", label: "Another" }, ...rest] },
        "variant",
      );
    });
    it("variant label differing only in case and width is the same label", () => {
      const selected = base.selected.map((s) => ({
        name: s.name.toUpperCase(),
        label: ` ${s.label.toUpperCase()} `,
      }));
      expect(compareChannel3({ ...base, selected }, p).variant).toBe("match");
    });
    it("an option Channel3 does not report is unknown", () => {
      const selected = [...base.selected, { name: "Size", label: "10" }];
      expect(compareChannel3({ ...base, selected }, p).variant).toBe("unknown");
    });
    it("price by one minor unit", () => {
      only({ ...base, priceMinor: String(BigInt(base.priceMinor) + 1n) }, "price");
    });
    it("currency", () => {
      only({ ...base, currency: "EUR" }, "price");
    });
    it("availability", () => {
      only({ ...base, available: !base.available }, "availability");
    });
    it("brand", () => {
      only({ ...base, brand: "Another Brand" }, "brand");
    });
    it("a domain with no offer leaves price and availability unknown", () => {
      const c = compareChannel3({ ...base, url: "https://store.example/products/x" }, p);
      expect(c).toMatchObject({ offerDomain: null, price: "unknown", availability: "unknown" });
    });
  });

  it.each(names)("%s: the observation document is JCS-stable and its sources are short", (name) => {
    const f = fixtures[name] as Fixture & { product: unknown };
    const build = () => {
      const p = normalizeProduct(f.product);
      const view = agreeingView(f.url, p);
      return observationDocument({
        id: "01K9ZQ3V1M0T4QF3Y3Z0E5T6V7",
        url: f.url,
        requestedAtMs: Date.parse(f.captured_at) - 600,
        receivedAtMs: Date.parse(f.captured_at),
        status: "ok",
        httpStatus: 200,
        responseSha256: `0x${"cd".repeat(32)}`,
        product: p,
        agentView: view,
        comparison: compareChannel3(view, p),
      });
    };
    const once = jcs(build());
    expect(jcs(build())).toBe(once);
    expect(Buffer.byteLength(once)).toBeLessThan(8 * 1024);
    const p = normalizeProduct(f.product);
    const sources = channel3Sources(
      "01K9ZQ3V1M0T4QF3Y3Z0E5T6V7",
      compareChannel3(agreeingView(f.url, p), p),
    );
    for (const s of Object.values(sources).flat()) expect(Buffer.byteLength(s)).toBeLessThan(80);
  });
});

describe("channel3PriceMinor", () => {
  it("formats to the currency's exponent instead of multiplying floats", () => {
    expect(channel3PriceMinor(149.99, "USD")).toBe("14999");
    expect(channel3PriceMinor(0.29, "USD")).toBe("29");
    expect(channel3PriceMinor(100, "USD")).toBe("10000");
  });
  it("JPY has no minor unit, and HUF is whole forints", () => {
    expect(channel3PriceMinor(3990, "JPY")).toBe("3990");
    expect(channel3PriceMinor(3990.5, "JPY")).toBe("");
    expect(channel3PriceMinor(1234, "HUF")).toBe("123400");
  });
  it("refuses what does not round-trip or is not a price", () => {
    expect(channel3PriceMinor(0.1 + 0.2, "USD")).toBe("");
    expect(channel3PriceMinor(1.005, "USD")).toBe("");
    expect(channel3PriceMinor(-1, "USD")).toBe("");
    expect(channel3PriceMinor(Number.NaN, "USD")).toBe("");
    expect(channel3PriceMinor(1e21, "USD")).toBe("");
    expect(channel3PriceMinor("10", "USD")).toBe("");
    expect(channel3PriceMinor(10, "XYZ")).toBe("");
  });
});

describe("normalizeProduct", () => {
  it("refuses what is not a product", () => {
    expect(() => normalizeProduct(null)).toThrow(TypeError);
    expect(() => normalizeProduct({ id: "x" })).toThrow(TypeError);
  });
});

describe("observationDocument", () => {
  it("records an unavailable lookup with every comparison unknown", () => {
    const view: AgentView = {
      contentHash,
      url: "https://jolyn.com/products/x",
      priceMinor: "795",
      currency: "USD",
      available: true,
      selected: [],
    };
    const comparison = compareChannel3(view, null);
    expect(comparison).toEqual({
      offerDomain: null,
      variant: "unknown",
      price: "unknown",
      availability: "unknown",
      brand: "unknown",
      mismatches: [],
    });
    const doc = observationDocument({
      id: "01K9ZQ3V1M0T4QF3Y3Z0E5T6V7",
      url: view.url,
      requestedAtMs: 1,
      receivedAtMs: 8001,
      status: "unavailable",
      error: "timeout",
      responseSha256: `0x${"00".repeat(32)}`,
      agentView: view,
      comparison,
    });
    expect(doc).toMatchObject({ status: "unavailable", error: "timeout", webhook_events: [] });
    expect(doc).not.toHaveProperty("product");
    expect(() => jcs(doc)).not.toThrow();
  });
  it("refuses a time that is not a safe integer", () => {
    const view: AgentView = {
      contentHash,
      url: "https://jolyn.com/products/x",
      priceMinor: "795",
      currency: "USD",
      available: true,
      selected: [],
    };
    expect(() =>
      observationDocument({
        id: "x",
        url: view.url,
        requestedAtMs: 1.5,
        receivedAtMs: 2,
        status: "ok",
        responseSha256: `0x${"00".repeat(32)}`,
        agentView: view,
        comparison: compareChannel3(view, null),
      }),
    ).toThrow(RangeError);
  });
});
