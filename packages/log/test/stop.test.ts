import { describe, expect, test } from "vitest";
import { leafHash, mandatesDigest, STOP_PREFIX, stopLeafBytes } from "../src/leaf.ts";

const a = new Uint8Array(32).fill(1);
const b = new Uint8Array(32).fill(2);

/** The same bytes `internal/alibilog` parses in `TestStopVector`. */
export const VECTOR =
  'keelson.finance/stop/v1\n{"issued_at":"2026-11-11T09:00:00Z","mandate_count":2,"mandates_digest":"-Biv03ptw7yS-0RzEBEncAbbTvpukCPNdGjAIzXSKk0","stop_id":"01KA0000000000000000000001"}';

describe("stop leaves", () => {
  test("commit to the sorted, unique mandate hashes, in canonical form", () => {
    const leaf = stopLeafBytes({
      stopId: "01KA0000000000000000000001",
      issuedAt: Date.UTC(2026, 10, 11, 9) / 1000,
      mandateHashes: [b, a, b],
    });
    expect(new TextDecoder().decode(leaf)).toBe(VECTOR);
    expect(mandatesDigest([a, b])).toEqual(mandatesDigest([b, a, a]));
    expect(leafHash(leaf)).toHaveLength(32);
    expect(VECTOR.startsWith(STOP_PREFIX)).toBe(true);
  });

  test("refuse what the log would refuse", () => {
    expect(() => stopLeafBytes({ stopId: "nope", issuedAt: 0, mandateHashes: [] })).toThrow(/ULID/);
    expect(() =>
      stopLeafBytes({
        stopId: "01KA0000000000000000000001",
        issuedAt: 0,
        mandateHashes: [new Uint8Array(31)],
      }),
    ).toThrow(/32 bytes/);
  });
});
