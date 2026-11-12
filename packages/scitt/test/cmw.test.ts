import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  readCollection,
  TEE_EVIDENCE_TYPE,
  TEE_LEGS_COLLECTION,
  teeCollection,
} from "../src/cmw.ts";
import { hasCddl, validateCddl } from "./cddl.ts";

const enc = new TextEncoder();
const tdx = enc.encode('{"kind":"tdx"}');
const nitro = enc.encode('{"kind":"nitro"}');

describe("CMW collection of the legs' evidence (RFC 9999)", () => {
  test("two legs make a typed JSON collection of evidence records", () => {
    expect(teeCollection({ tdx, nitro })).toEqual({
      __cmwc_t: "tag:keelson.finance,2026:tee-legs",
      tdx: [TEE_EVIDENCE_TYPE, Buffer.from(tdx).toString("base64url"), 4],
      nitro: [TEE_EVIDENCE_TYPE, Buffer.from(nitro).toString("base64url"), 4],
    });
    expect(TEE_LEGS_COLLECTION).toBe("tag:keelson.finance,2026:tee-legs");
    expect(TEE_EVIDENCE_TYPE).toBe("application/vnd.keelson.tee-evidence+json");
  });

  test("a degraded purchase has the tdx record only", () => {
    expect(Object.keys(teeCollection({ tdx }))).toEqual(["__cmwc_t", "tdx"]);
  });

  test("reads a collection back", () => {
    const records = readCollection(teeCollection({ tdx, nitro }));
    expect(records.get("nitro")).toEqual({ type: TEE_EVIDENCE_TYPE, value: nitro, ind: 4 });
    expect([...records.keys()]).toEqual(["tdx", "nitro"]);
  });

  test.each([
    ["no __cmwc_t", { tdx: [TEE_EVIDENCE_TYPE, "AA", 4] }],
    ["an ind of 0", { __cmwc_t: TEE_LEGS_COLLECTION, tdx: [TEE_EVIDENCE_TYPE, "AA", 0] }],
    ["an ind of 32", { __cmwc_t: TEE_LEGS_COLLECTION, tdx: [TEE_EVIDENCE_TYPE, "AA", 32] }],
    ["a padded value", { __cmwc_t: TEE_LEGS_COLLECTION, tdx: [TEE_EVIDENCE_TYPE, "AA==", 4] }],
    [
      "a standard-base64 value",
      { __cmwc_t: TEE_LEGS_COLLECTION, tdx: [TEE_EVIDENCE_TYPE, "a+b/", 4] },
    ],
    ["no entries", { __cmwc_t: TEE_LEGS_COLLECTION }],
    ["not an object", [TEE_EVIDENCE_TYPE, "AA"]],
  ])("refuses %s", (_, value) => {
    expect(() => readCollection(value)).toThrow(expect.objectContaining({ code: "cmw" }));
  });

  test("the interop fixture Go reads is what this code writes", () => {
    const file = new URL("../../../internal/scitt/testdata/cmw.json", import.meta.url);
    const out = `${JSON.stringify(teeCollection({ tdx, nitro }), null, 2)}\n`;
    if (process.env.KEELSON_WRITE_VECTORS === "1") writeFileSync(file, out);
    expect(readFileSync(file, "utf8")).toBe(out);
  });

  test.skipIf(!hasCddl())("validates against the RFC 9999 CDDL", () => {
    const json = enc.encode(JSON.stringify(teeCollection({ tdx, nitro })));
    expect(validateCddl("rfc9999.cddl", "json-collection", json, "json")).toBe(true);
    // cddl 0.10.7 checks the collection's envelope only: it accepts any member keyed by `&(label:
    // text)` and has no `.bits`, so the records' rules are readCollection's, tested above.
    const record = enc.encode(JSON.stringify([TEE_EVIDENCE_TYPE, "AA", 4]));
    expect(validateCddl("rfc9999.cddl", "json-collection", record, "json")).toBe(false);
  });
});
