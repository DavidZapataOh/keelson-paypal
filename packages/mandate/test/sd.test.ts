import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DST, hashObject } from "@keelson/core";
import { BN254_FR_MODULUS } from "@keelson/core/poseidon2";
import { describe, expect, it } from "vitest";
import { hSd, mandateChallenge } from "../src/challenge.ts";
import { type Mandate, parseMandate } from "../src/schema.ts";
import {
  buildSdPayload,
  decodeDisclosed,
  decodeMandate,
  merchantDisclosures,
  SD_FIELDS,
} from "../src/sd.ts";
import demo from "./fixtures/demo-mandate.json" with { type: "json" };

/** The demo mandate, with a budget that differs from the per-purchase cap. */
function mandate(): Mandate {
  const m = structuredClone(demo) as unknown as Mandate;
  for (const c of m.payment.constraints) if (c.type === "payment.budget") c.max = 25000;
  return parseMandate(m);
}
const randomSalt = () => crypto.getRandomValues(new Uint8Array(16));

const decode = (d: string): unknown[] => JSON.parse(Buffer.from(d, "base64url").toString("utf8"));

/** Drops every value that `hidden` would have revealed: claims, or array elements. */
function withoutDisclosures(m: Mandate, hidden: string[]): unknown {
  const claims: [string, unknown][] = [];
  const elements: unknown[] = [];
  for (const d of hidden) {
    const parts = decode(d);
    if (parts.length === 3) claims.push([parts[1] as string, parts[2]]);
    else elements.push(parts[1]);
  }
  const isHidden = (k: string, x: unknown) =>
    claims.some(([ck, cv]) => ck === k && isDeepStrictEqual(cv, x));
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.filter((x) => !elements.some((e) => isDeepStrictEqual(e, x))).map(walk);
    }
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([k, x]) => !isHidden(k, x))
          .map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };
  return walk(m);
}

function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .reverse()
        .map(([k, x]) => [k, reverseKeys(x)]),
    );
  }
  return v;
}

describe("buildSdPayload", () => {
  it("hides every selectively disclosable field behind a digest", async () => {
    const m = mandate();
    const { payloadSd, disclosures } = await buildSdPayload(m, randomSalt);
    const json = JSON.stringify(payloadSd);
    for (const secret of [
      m.user.app_login_id,
      m.user.sub,
      m.user.cred.id,
      m.user.cred.jwk.x,
      m.intent.prompt_summary,
      m.intent.prompt_hash,
      "25000",
      "10000",
      "fp_3c9a71",
      "203.0.113.7",
      "MERCH7XK2Q9LD",
      "mrc_runfast",
      "sku-trail-10",
      "payment.amount_range",
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(disclosures).toHaveLength(11);
    expect(SD_FIELDS).toHaveLength(11);
    expect((payloadSd as Mandate).nonce).toBe(m.nonce);
  });

  it("binds the agent key as the delegate cnf", async () => {
    const m = mandate();
    const { payloadSd } = await buildSdPayload(m, randomSalt);
    expect((payloadSd as { cnf: unknown }).cnf).toEqual({ jwk: m.agent.cnf.jwk });
  });

  it("uses each 128-bit salt once, base64url-encoded", async () => {
    const salts: Uint8Array[] = [];
    const { disclosures } = await buildSdPayload(mandate(), () => {
      const s = randomSalt();
      salts.push(s);
      return s;
    });
    const used = disclosures.map((d) => decode(d)[0]);
    expect(used).toEqual(salts.map((s) => Buffer.from(s).toString("base64url")));
    expect(new Set(used).size).toBe(used.length);
  });

  it("rejects salts that are not 16 bytes", async () => {
    await expect(buildSdPayload(mandate(), () => new Uint8Array(15))).rejects.toThrow(RangeError);
  });

  it("validates the mandate first", async () => {
    const bad = { ...mandate(), v: "keelson.mandate.0" } as unknown as Mandate;
    await expect(buildSdPayload(bad, randomSalt)).rejects.toThrow("v");
  });
});

describe("decodeDisclosed", () => {
  it("decodes every subset of disclosures, leaving undisclosed fields absent", async () => {
    const m = mandate();
    const { payloadSd, disclosures } = await buildSdPayload(m, randomSalt);
    expect(decodeDisclosed(payloadSd, disclosures)).toEqual(m);
    for (let mask = 0; mask < 1 << disclosures.length; mask++) {
      const shown = disclosures.filter((_, i) => mask & (1 << i));
      const hidden = disclosures.filter((_, i) => !(mask & (1 << i)));
      expect(decodeDisclosed(payloadSd, shown)).toEqual(withoutDisclosures(m, hidden));
    }
  }, 60_000);

  it("removes exactly the selectively disclosable fields when nothing is disclosed", async () => {
    const m = mandate();
    const { payloadSd, disclosures } = await buildSdPayload(m, randomSalt);
    const bare = decodeDisclosed(payloadSd, []);
    expect(bare).toEqual(withoutDisclosures(m, disclosures));
    expect(bare.user?.app_login_id).toBeUndefined();
    expect(bare.risk_data).toBeUndefined();
    expect(bare.payment?.constraints?.map((c) => c.type)).not.toContain("payment.amount_range");
  });

  it("throws on a duplicate disclosure", async () => {
    const { payloadSd, disclosures } = await buildSdPayload(mandate(), randomSalt);
    expect(() => decodeDisclosed(payloadSd, [...disclosures, disclosures[0] as string])).toThrow(
      /[Dd]uplicate/,
    );
  });

  it("throws on a disclosure whose digest is not in the payload", async () => {
    const a = await buildSdPayload(mandate(), randomSalt);
    const b = await buildSdPayload(mandate(), randomSalt);
    expect(() => decodeDisclosed(a.payloadSd, [b.disclosures[0] as string])).toThrow(
      /[Uu]nreferenced/,
    );
  });

  it("throws when the delegate cnf differs from the agent key", async () => {
    const { payloadSd, disclosures } = await buildSdPayload(mandate(), randomSalt);
    const forged = { ...payloadSd, cnf: { jwk: mandate().user.cred.jwk } };
    expect(() => decodeDisclosed(forged, disclosures)).toThrow(/cnf/);
  });

  it("rejects an _sd_alg other than sha-256", async () => {
    const { payloadSd, disclosures } = await buildSdPayload(mandate(), randomSalt);
    for (const alg of ["sha-512", "SHA-256", "sha-384"]) {
      expect(() => decodeDisclosed({ ...payloadSd, _sd_alg: alg }, disclosures)).toThrow(/_sd_alg/);
    }
    expect(decodeDisclosed({ ...payloadSd, _sd_alg: "sha-256" }, disclosures)).toEqual(mandate());
  });
});

/** The demo mandate with a second merchant, its payee and a second acceptable item. */
function twoMerchants(): Mandate {
  const m = mandate();
  for (const c of m.payment.constraints) {
    if (c.type === "payment.allowed_payees")
      c.allowed.push({ paypal_merchant_id: "MERCH2TRAILCO" });
  }
  for (const c of m.checkout.constraints) {
    if (c.type === "checkout.allowed_merchants") {
      c.allowed.push({
        id: "mrc_trailco",
        name: "TrailCo",
        website: "https://trailco.example",
        paypal_merchant_id: "MERCH2TRAILCO",
      });
    }
    if (c.type === "checkout.line_items") {
      c.items[0]?.acceptable_items.push({ id: "sku-trail-11", title: "Trail shoe, wide" });
    }
  }
  return parseMandate(m);
}

describe("merchantDisclosures", () => {
  const view = async (opts: Parameters<typeof merchantDisclosures>[1]) => {
    const m = twoMerchants();
    const { payloadSd, disclosures } = await buildSdPayload(m, randomSalt);
    return { m, seen: decodeDisclosed(payloadSd, merchantDisclosures(disclosures, opts)) };
  };

  it("shows a merchant only its own entries, withholding the cap, budget, prompt hash and user", async () => {
    const { seen } = await view({ merchant: "mrc_runfast" });
    expect(seen.user).toEqual({});
    expect(seen.intent).toEqual({ subjective: ["look good"] });
    expect(seen.risk_data).toBeUndefined();
    expect(seen.payment?.constraints).toEqual([
      { type: "payment.budget", currency: "USD" },
      { type: "payment.allowed_payees", allowed: [{ paypal_merchant_id: "MERCH7XK2Q9LD" }] },
      { type: "payment.execution_date", not_after: "2026-11-13T23:59:59Z" },
    ]);
    const checkout = seen.checkout?.constraints;
    expect(checkout?.[0]).toEqual({
      type: "checkout.allowed_merchants",
      allowed: [
        {
          id: "mrc_runfast",
          name: "RunFast",
          website: "https://runfast.example",
          paypal_merchant_id: "MERCH7XK2Q9LD",
        },
      ],
    });
    expect(checkout?.[1]).toEqual({
      type: "checkout.line_items",
      items: [{ id: "l1", acceptable_items: [], quantity: 1 }],
    });
  });

  it("adds the requested items and, when the user chooses, the cap", async () => {
    const { m, seen } = await view({ merchant: "mrc_trailco", items: ["sku-trail-11"], cap: true });
    expect(seen.payment?.constraints?.[0]).toEqual(m.payment.constraints[0]);
    expect(seen.payment?.constraints?.[1]).toEqual({ type: "payment.budget", currency: "USD" });
    expect(seen.payment?.constraints?.[2]).toEqual({
      type: "payment.allowed_payees",
      allowed: [{ paypal_merchant_id: "MERCH2TRAILCO" }],
    });
    expect(seen.checkout?.constraints?.[1]).toEqual({
      type: "checkout.line_items",
      items: [
        {
          id: "l1",
          acceptable_items: [{ id: "sku-trail-11", title: "Trail shoe, wide" }],
          quantity: 1,
        },
      ],
    });
    expect(seen.user).toEqual({});
    expect(seen.intent?.prompt_hash).toBeUndefined();
  });

  it("throws for a merchant that is not in the mandate", async () => {
    await expect(view({ merchant: "mrc_unknown" })).rejects.toThrow(/mrc_unknown/);
  });
});

describe("hSd", () => {
  it("is H(keelson/mandate/v1, payload_SD) and stable under key order", async () => {
    const { payloadSd } = await buildSdPayload(mandate(), randomSalt);
    const h = hSd(payloadSd);
    expect(h).toHaveLength(32);
    expect(h).toEqual(hashObject(DST.mandate, payloadSd as never));
    expect(hSd(reverseKeys(payloadSd) as object)).toEqual(h);
    expect(JSON.stringify(reverseKeys(payloadSd))).not.toBe(JSON.stringify(payloadSd));
  });

  it("changes when any digest changes", async () => {
    const { payloadSd } = await buildSdPayload(mandate(), randomSalt);
    const other = await buildSdPayload(mandate(), randomSalt);
    expect(hSd(other.payloadSd)).not.toEqual(hSd(payloadSd));
  });
});

describe("mandateChallenge", () => {
  const h = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + (i % 16));

  it("is SHA-256(dst || 0x00 || H_sd || be32(C_m))", () => {
    for (const cm of [0n, 1n, 0x0102n, BN254_FR_MODULUS - 1n]) {
      const be32 = Buffer.from(cm.toString(16).padStart(64, "0"), "hex");
      const expected = createHash("sha256")
        .update("keelson/mandate-challenge/v1")
        .update(Buffer.from([0]))
        .update(h)
        .update(be32)
        .digest();
      expect(Buffer.from(mandateChallenge(h, cm))).toEqual(expected);
    }
  });

  it("rejects an H_sd that is not 32 bytes and a C_m outside the field", () => {
    expect(() => mandateChallenge(h.subarray(1), 1n)).toThrow(RangeError);
    expect(() => mandateChallenge(h, -1n)).toThrow(RangeError);
    expect(() => mandateChallenge(h, BN254_FR_MODULUS)).toThrow(RangeError);
  });
});

describe("decodeDisclosed input limits", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const digestOf = (d: string) => createHash("sha256").update(d).digest("base64url");
  /** `payloadSd` with one extra top-level disclosure whose raw JSON is `json`. */
  async function withRaw(json: string) {
    const { payloadSd, disclosures } = await buildSdPayload(mandate(), randomSalt);
    const d = b64(json);
    const p = structuredClone(payloadSd) as { _sd: string[] };
    p._sd.push(digestOf(d));
    return () => decodeDisclosed(p, [...disclosures, d]) as unknown as Record<string, unknown>;
  }

  it("accepts only safe integers as numbers", async () => {
    for (const n of ["9007199254740991", "-9007199254740991", "0", "-1"]) {
      expect((await withRaw(`["s","n",${n}]`))()).toHaveProperty("n");
    }
    for (const n of ["1.0", "-0", "1e2", "1e400", "9007199254740992", "1.5", "-0.0"]) {
      expect(await withRaw(`["s","n",${n}]`)).toThrow(/number/);
    }
  });

  it("rejects lone surrogates", async () => {
    expect(await withRaw('["s","n","\\ud800"]')).toThrow(/surrogate/);
    expect(await withRaw('["s","n",{"\\udc00":1}]')).toThrow(/surrogate/);
  });

  it("rejects nesting deeper than 32 levels", async () => {
    const nest = (n: number) => "[".repeat(n) + "]".repeat(n);
    expect((await withRaw(`["s","n",${nest(31)}]`))()).toHaveProperty("n");
    expect(await withRaw(`["s","n",${nest(32)}]`)).toThrow(/deep/);
  });

  it("rejects a chain of 5,000 nested disclosures with the depth check", () => {
    let payload: object = {};
    const disclosures: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const d = b64(JSON.stringify([`salt${i}`, "c", payload]));
      payload = { _sd: [digestOf(d)] };
      disclosures.push(d);
    }
    expect(() => decodeDisclosed(payload, disclosures)).toThrow(/disclosed claims nested too deep/);
  });

  it("rejects an Object.prototype name as an array placeholder digest", async () => {
    const { payloadSd, disclosures } = await buildSdPayload(mandate(), randomSalt);
    const p = structuredClone(payloadSd) as { intent: { subjective: unknown[] } };
    p.intent.subjective.push({ "...": "toString" });
    expect(() => decodeDisclosed(p, disclosures)).toThrow(/toString/);
  });
});

describe("decodeMandate", () => {
  it("decodes and parses a fully disclosed mandate", async () => {
    const m = mandate();
    const { payloadSd, disclosures } = await buildSdPayload(m, randomSalt);
    expect(decodeMandate(payloadSd, disclosures)).toEqual(m);
  });

  it("rejects any withheld disclosure, including a single array element", async () => {
    const { payloadSd, disclosures } = await buildSdPayload(twoMerchants(), randomSalt);
    for (const d of disclosures) {
      expect(() =>
        decodeMandate(
          payloadSd,
          disclosures.filter((x) => x !== d),
        ),
      ).toThrow(/digest/);
    }
  });
});

describe("decoy digests", () => {
  /** How many entries each SD list or array holds, in order. */
  const shape = (v: unknown): number[] => {
    if (v === null || typeof v !== "object") return [];
    if (Array.isArray(v)) {
      const sd = v.filter((x) => x !== null && typeof x === "object" && "..." in x).length;
      const own = sd > 0 ? [sd] : [];
      return [...own, ...v.flatMap(shape)];
    }
    const o = v as Record<string, unknown>;
    return [
      ...(Array.isArray(o._sd) ? [o._sd.length] : []),
      ...Object.entries(o).flatMap(([k, x]) => (k === "_sd" ? [] : shape(x))),
    ];
  };

  it("a merchant sees the same counts for a one- and a three-merchant mandate", async () => {
    const three = twoMerchants();
    for (const c of three.checkout.constraints) {
      if (c.type === "checkout.allowed_merchants") {
        c.allowed.push({
          id: "mrc_third",
          name: "Third",
          website: "https://third.example",
          paypal_merchant_id: "MERCH3",
        });
      }
    }
    const one = await buildSdPayload(mandate(), randomSalt, { decoys: true });
    const many = await buildSdPayload(parseMandate(three), randomSalt, { decoys: true });
    expect(shape(one.payloadSd)).toEqual(shape(many.payloadSd));
    for (const n of shape(one.payloadSd)) expect([4, 8, 16, 32, 64]).toContain(n);
    expect(one.decoySalts.length).toBeGreaterThan(0);
  });

  it("decoys resolve only with their salts, and the mandate decodes the same", async () => {
    const m = mandate();
    const { payloadSd, disclosures, decoySalts } = await buildSdPayload(m, randomSalt, {
      decoys: true,
    });
    expect(decodeMandate(payloadSd, disclosures, decoySalts)).toEqual(m);
    expect(() => decodeMandate(payloadSd, disclosures)).toThrow("undisclosed digest");
    expect(() =>
      decodeMandate(payloadSd, disclosures, [...decoySalts, "AAAAAAAAAAAAAAAAAAAAAA"]),
    ).toThrow("decoy");
  });

  it("a merchant view never carries a decoy salt", async () => {
    const { disclosures, decoySalts } = await buildSdPayload(twoMerchants(), randomSalt, {
      decoys: true,
    });
    const shown = merchantDisclosures(disclosures, { merchant: "mrc_runfast" });
    for (const s of decoySalts) expect(shown.join()).not.toContain(s);
  });

  it("a mandate without decoys still decodes as before", async () => {
    const m = mandate();
    const { payloadSd, disclosures, decoySalts } = await buildSdPayload(m, randomSalt);
    expect(decoySalts).toEqual([]);
    expect(decodeMandate(payloadSd, disclosures)).toEqual(m);
  });
});
