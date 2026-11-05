import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DST, hashObject } from "@keelson/core";
import { BN254_FR_MODULUS } from "@keelson/core/poseidon2";
import { describe, expect, it } from "vitest";
import { hSd, mandateChallenge } from "../src/challenge.ts";
import { type Mandate, parseMandate } from "../src/schema.ts";
import { buildSdPayload, decodeDisclosed, SD_FIELDS } from "../src/sd.ts";
import demo from "./fixtures/demo-mandate.json" with { type: "json" };

const mandate = (): Mandate => parseMandate(structuredClone(demo));
const randomSalt = () => crypto.getRandomValues(new Uint8Array(16));

const decode = (d: string): unknown[] => JSON.parse(Buffer.from(d, "base64url").toString("utf8"));

/** Drops every value that `hidden` would have revealed: claim names, or array elements. */
function withoutDisclosures(m: Mandate, hidden: string[]): unknown {
  const keys = new Set<string>();
  const elements: unknown[] = [];
  for (const d of hidden) {
    const parts = decode(d);
    if (parts.length === 3) keys.add(parts[1] as string);
    else elements.push(parts[1]);
  }
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.filter((x) => !elements.some((e) => isDeepStrictEqual(e, x))).map(walk);
    }
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => !keys.has(k))
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
      m.intent.prompt_summary,
      "fp_3c9a71",
      "203.0.113.7",
      "MERCH7XK2Q9LD",
      "mrc_runfast",
      "sku-trail-10",
      "payment.amount_range",
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(disclosures).toHaveLength(7);
    expect(SD_FIELDS).toHaveLength(7);
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
  });

  it("removes exactly the selectively disclosable fields when nothing is disclosed", async () => {
    const m = mandate();
    const { payloadSd, disclosures } = await buildSdPayload(m, randomSalt);
    const bare = decodeDisclosed(payloadSd, []);
    expect(bare).toEqual(withoutDisclosures(m, disclosures));
    expect(bare.user.app_login_id).toBeUndefined();
    expect(bare.risk_data).toBeUndefined();
    expect(bare.payment.constraints.map((c) => c.type)).not.toContain("payment.amount_range");
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
