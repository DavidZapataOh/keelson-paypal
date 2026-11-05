// RFC 8785 vectors: https://github.com/cyberphone/json-canonicalization
// testdata/input and testdata/output at commit 32a48195b9b20fe67b1795e39e4509f14d860b45.
// values.json is excluded: it contains non-integer numbers, which jcs() rejects by design.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Json, jcs } from "../src/jcs.ts";
import raw from "./vectors/jcs-raw.json" with { type: "json" };

const vectors = ["arrays", "french", "structures", "unicode", "weird"];
const excluded = ["values"];
const read = (dir: string, name: string): string =>
  readFileSync(new URL(`./rfc8785/${dir}/${name}.json`, import.meta.url), "utf8");

describe("jcs RFC 8785 vectors", () => {
  it.each(vectors)("%s", (name) => {
    expect(jcs(JSON.parse(read("input", name)) as Json)).toBe(read("output", name));
  });

  it.each(excluded)("%s is excluded (non-integer numbers) and rejected", (name) => {
    expect(() => jcs(JSON.parse(read("input", name)) as Json)).toThrow("non-integer number");
  });
});

describe("jcs", () => {
  it("sorts keys and keeps arrays ordered", () => {
    expect(jcs({ b: 1, a: [true, null] })).toBe('{"a":[true,null],"b":1}');
  });

  it("serializes negative zero as 0", () => {
    expect(jcs(-0)).toBe("0");
  });

  it("rejects non-integer numbers", () => {
    expect(() => jcs(1.5)).toThrow(new TypeError("non-integer number"));
    expect(() => jcs(Number.NaN)).toThrow(new TypeError("non-integer number"));
    expect(() => jcs(Number.POSITIVE_INFINITY)).toThrow(new TypeError("non-integer number"));
  });

  it("rejects integers outside the safe range", () => {
    expect(() => jcs(2 ** 53)).toThrow(new TypeError("unsafe integer"));
    expect(() => jcs(-(2 ** 53))).toThrow(new TypeError("unsafe integer"));
    expect(jcs(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    expect(jcs(Number.MIN_SAFE_INTEGER)).toBe("-9007199254740991");
  });

  it("escapes control characters the RFC 8785 way", () => {
    expect(jcs('\b\f\n\r\t\u0000\u001f\u007f"\\/')).toBe(
      '"\\b\\f\\n\\r\\t\\u0000\\u001f\u007f\\"\\\\/"',
    );
  });

  it("rejects lone surrogates in values and keys", () => {
    const loneSurrogate = new TypeError("lone surrogate");
    expect(() => jcs("\ud800")).toThrow(loneSurrogate);
    expect(() => jcs({ "\udc00": 1 })).toThrow(loneSurrogate);
    expect(() => jcs(["ok", { a: "\ud800" }])).toThrow(loneSurrogate);
  });

  it("rejects non-integers nested in containers", () => {
    expect(() => jcs({ a: [1, { b: 0.5 }] })).toThrow("non-integer number");
  });
});

describe("raw JSON parity vectors", () => {
  it.each(raw)("$name", ({ input, expected }) => {
    if (expected === "error") expect(() => jcs(JSON.parse(input) as Json)).toThrow();
    else expect(jcs(JSON.parse(input) as Json)).toBe(expected);
  });
});
