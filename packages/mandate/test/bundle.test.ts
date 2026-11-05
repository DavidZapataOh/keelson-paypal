import { expect, test } from "vitest";
import { INITIAL_BUDGET_BYTES, measureBrowserBundle } from "../scripts/bundle-size.ts";

test("the browser entry stays within budget and loads bb.js lazily", {
  timeout: 60_000,
}, async () => {
  const r = await measureBrowserBundle();
  expect(r.exports).toEqual(
    expect.arrayContaining([
      "passkeyRegistrationOptions",
      "prepareSigning",
      "rememberPaymentPasskey",
      "signMandate",
    ]),
  );
  expect(r.initialGzip, `initial ${r.initialGzip} B gzipped`).toBeLessThanOrEqual(
    INITIAL_BUDGET_BYTES,
  );
  expect(r.wasmChunks).toHaveLength(1);
  expect(r.wasmChunks[0]?.initial).toBe(false);
});
