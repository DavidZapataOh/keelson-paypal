import { exportAcp, purchaseFacts } from "@keelson/interop";
import { describe, expect, test } from "vitest";
import { ALLOW_PAYPAL, alibi, NOW, testIssuer } from "../../../packages/interop/test/fixtures.ts";
import { RECEIPT_KEYS, v2Ref } from "../../../packages/interop/test/v2.ts";
import { checkExport, exportOf } from "../src/exports.ts";

describe("exportOf", () => {
  test("recognizes each Keelson export by its type", () => {
    expect(exportOf({ type: "keelson.ap2/1" })).toEqual({
      format: "ap2",
      name: "AP2 mandates and receipts",
    });
    expect(exportOf({ type: "keelson.vi/1" })?.format).toBe("vi");
    expect(exportOf({ type: "keelson.ucp/1" })?.format).toBe("ucp");
    expect(exportOf({ type: "keelson.acp/1" })?.format).toBe("acp");
    expect(exportOf({ type: "keelson.tap/1" })?.format).toBe("tap");
    expect(exportOf({ type: "keelson.visa-evidence-pack/1" })?.format).toBe("visa");
  });

  test("an Alibi or anything else is not an export", () => {
    expect(exportOf({ type: "application/vnd.keelson.alibi.v2+json" })).toBeNull();
    expect(exportOf(null)).toBeNull();
    expect(exportOf([])).toBeNull();
  });
});

test("an export is checked in the browser against its statement, with no network", async () => {
  const issuer = await testIssuer(ALLOW_PAYPAL);
  const x = await exportAcp(
    purchaseFacts(alibi(ALLOW_PAYPAL)),
    v2Ref("allow-2of2"),
    { issuer },
    { now: NOW },
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network used");
  };
  try {
    const ok = await checkExport(x, {
      now: NOW,
      issuerKeys: [issuer.jwk],
      receiptKeys: RECEIPT_KEYS,
    });
    expect(ok.ok).toBe(true);
    const pinned = await checkExport(x, { now: NOW });
    expect(pinned.checks.find((c) => c.id === "issuer")?.ok).toBe(false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
