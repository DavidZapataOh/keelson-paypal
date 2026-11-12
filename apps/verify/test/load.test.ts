import { describe, expect, test } from "vitest";
import { fromText, parseJson } from "../src/load.ts";
import { parseRoute, verifyLinkOf } from "../src/route.ts";

const id = "01M6W3TTKRC43V70XQAT1QQK6V";
const b64 = "hHEpl-5CT_WVAREiarj1XwJlOT324Zq05OpTpEtEa9c";
const hex = "84712997ee424ff5951011226ab8f55f02653933f6e19ab4e4ea53a44b446bd7";
const at = (url: string) => new URL(url, "https://verify.keelson.finance");

describe("parseRoute", () => {
  test("the canonical link verifyUrl issues", () => {
    expect(parseRoute(at(`/a/${id}#${b64}.1234.421614`))).toEqual({
      alibiId: id,
      expect: { leafHash: b64, anchoredSize: 1234n, chainId: 421614 },
    });
  });

  test("/v/ and a hex leaf hash", () => {
    expect(parseRoute(at(`/v/${id}#${hex}.1234.421614`)).expect?.leafHash).toBe(hex);
  });

  test("no fragment, or a malformed one, states nothing", () => {
    expect(parseRoute(at(`/a/${id}`))).toEqual({ alibiId: id });
    expect(parseRoute(at(`/a/${id}#${b64.slice(1)}.1.421614`))).toEqual({ alibiId: id });
  });

  test("?proof=anonymous asks for the anonymous proof first", () => {
    expect(parseRoute(at(`/a/${id}?embed&proof=anonymous`))).toEqual({
      alibiId: id,
      embed: true,
      anonymous: true,
    });
    expect(parseRoute(at(`/a/${id}?proof=other`)).anonymous).toBeUndefined();
  });

  test("a size of 0 states no anchor", () => {
    expect(parseRoute(at(`/a/${id}#${b64}.0.421614`)).expect).toEqual({
      leafHash: b64,
      chainId: 421614,
    });
  });

  test("?embed asks for the framed layout", () => {
    expect(parseRoute(at(`/a/${id}?embed#${b64}.1234.421614`)).embed).toBe(true);
    expect(parseRoute(at(`/a/${id}#${b64}.1234.421614`)).embed).toBeUndefined();
  });

  test("only an https RPC is accepted", () => {
    expect(parseRoute(at("/?rpc=https://rpc.example/x")).rpc).toBe("https://rpc.example/x");
    expect(parseRoute(at("/?rpc=http://x")).rpcRefused).toBeDefined();
    expect(parseRoute(at("/?rpc=javascript:alert(1)")).rpcRefused).toBeDefined();
    expect(parseRoute(at("/?rpc=javascript:alert(1)")).rpc).toBeUndefined();
  });

  test("a QR code is a verify link only on the verifier's origin", () => {
    const origins = ["https://verify.keelson.finance"];
    expect(verifyLinkOf(`https://verify.keelson.finance/a/${id}`, origins)?.alibiId).toBe(id);
    expect(verifyLinkOf("https://example.com", origins)).toBeUndefined();
    expect(verifyLinkOf(`https://example.com/a/${id}`, origins)).toBeUndefined();
  });
});

describe("hostile input", () => {
  test("prototype keys are refused", () => {
    expect(() => parseJson('{"__proto__":{}}')).toThrow(/__proto__/);
    expect(() => parseJson('{"a":{"constructor":1}}')).toThrow(/constructor/);
  });

  test("deep nesting is refused before parsing", () => {
    expect(() => parseJson(`${"[".repeat(10_000)}${"]".repeat(10_000)}`)).toThrow(/deeply/);
  });

  test("more than 8 MB is refused", () => {
    expect(() => parseJson(`"${"a".repeat(9 * 1024 * 1024)}"`)).toThrow(/8 MB/);
  });

  test("JSON that is not an Alibi is refused with a pointer", () => {
    expect(() => fromText("[]")).toThrow(/not an Alibi/);
    expect(() => fromText('{"alibi_id":"x"}')).toThrow(/not a valid Alibi/);
  });
});

test("the deployed site serves the policy previews are tested under", async () => {
  const { readFileSync } = await import("node:fs");
  const { CSP } = await import("../vite.config.ts");
  const yaml = readFileSync(new URL("../../../render.yaml", import.meta.url), "utf8");
  expect(yaml).toContain(`value: "${CSP}"`);
});

describe("a dropped .cose", () => {
  test("loads as a v2 statement without its log proof", async () => {
    const { statementOf } = await import("@keelson/alibi");
    const { v2Bundle } = await import("../../../packages/alibi/test/v2.ts");
    const { fromFile } = await import("../src/load.ts");
    const b = v2Bundle();
    const cose = statementOf(b);
    const loaded = await fromFile(new Blob([cose as Uint8Array<ArrayBuffer>]));
    expect(loaded.alibi.alibi_id).toBe(b.alibi_id);
    expect("statement" in loaded.alibi && !("tlog_proof" in loaded.alibi)).toBe(true);
    expect(loaded.bytes).toEqual(cose);
  });

  test("a COSE file that is not an Alibi's statement is refused", async () => {
    const { fromFile } = await import("../src/load.ts");
    await expect(
      fromFile(new Blob([Uint8Array.of(0xd2, 0x84, 0x40, 0xa0, 0xf6, 0x40)])),
    ).rejects.toThrow("not an Alibi's SCITT statement");
  });
});
