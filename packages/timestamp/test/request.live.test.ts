import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";
import { opensslVerify } from "../scripts/openssl-verify.ts";
import { requestTimestamp, TimestampError } from "../src/index.ts";

const live = process.env.KEELSON_LIVE === "1";

describe.skipIf(!live)("live TSAs", () => {
  for (const tsa of ["digicert", "sigstore"] as const) {
    test(`${tsa} stamps a SHA-256 imprint as given`, async () => {
      const imprint = sha256(utf8ToBytes(`keelson timestamp test ${Date.now()}`));
      const stamp = await requestTimestamp(tsa, imprint);

      expect(stamp.tsa).toBe(tsa);
      expect(Math.abs(stamp.genTime.getTime() - Date.now())).toBeLessThan(5 * 60_000);
      expect(stamp.serial).toMatch(/^[0-9a-f]+$/);
      expect(stamp.nonce).toBeGreaterThan(0n);
      expect(opensslVerify(tsa, stamp.token, imprint)).toContain("Verification: OK");
      console.info(`${tsa}: ${stamp.latencyMs} ms, ${stamp.token.length} B`);
    });
  }

  test("a TSA that never answers times out", async () => {
    // A server that never replies; a non-routable address may fail fast instead.
    const silent = createServer(() => {});
    await new Promise<void>((done) => silent.listen(0, "127.0.0.1", done));
    const { port } = silent.address() as AddressInfo;
    const started = performance.now();
    const error = await requestTimestamp(
      { id: "digicert", url: `http://127.0.0.1:${port}/` },
      new Uint8Array(32),
      { timeoutMs: 500 },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimestampError);
    expect((error as TimestampError).code).toBe("tsa-timeout");
    expect(performance.now() - started).toBeLessThan(700);
    silent.closeAllConnections();
    silent.close();
  });

  test("an HTTP error is reported as such", async () => {
    const error = await requestTimestamp(
      { id: "sigstore", url: "https://timestamp.sigstore.dev/api/v1/does-not-exist" },
      new Uint8Array(32),
    ).catch((e: unknown) => e);
    expect((error as TimestampError).code).toBe("tsa-http");
  });
});
