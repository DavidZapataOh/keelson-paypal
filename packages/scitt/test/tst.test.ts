import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { expect, test } from "vitest";
import { statementImprint } from "../src/tst.ts";

test("the 3161-ctt imprint of RFC 9921 §3.1.1's example", () => {
  const signature = hexToBytes(
    "8eb33e4ca31d1c465ab05aac34cc6b23d58fef5c083106c4d25a91aef0b0117e2af9a291aa32e14ab834dc56ed2a223444547e01f11d3b0916e5a4c345cacb36",
  );
  expect(bytesToHex(statementImprint(signature))).toBe(
    "44c2419d131d53d55584b5dd33b788c24e551c6d44b1afc8b2b85e6954763b4e",
  );
});
