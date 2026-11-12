import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { deploymentsFor } from "@keelson/chain";
import { describe, expect, test } from "vitest";
import { docFiles, REPO } from "./lib/markdown";

const measurements = JSON.parse(
  readFileSync(join(REPO, "engine/tee/measurements.json"), "utf8"),
) as {
  oci_digest: string;
  tdx: { id: string };
  nitro: { id: string };
};
const contracts = new Set(Object.values(deploymentsFor(421614)).map((a) => a.toLowerCase()));
const CONTRACT_LINE = /contract|Anchor|Vault|Reserve|Verifier|Court|Bond|Registry/;

describe("the verify page's addresses", () => {
  test("every address on it is a current deployment", () => {
    const page = readFileSync(
      join(REPO, "apps/docs/src/content/docs/security/verify.mdoc"),
      "utf8",
    );
    const stale = (page.match(/0x[0-9a-fA-F]{40}\b/g) ?? []).filter(
      (a) => !contracts.has(a.toLowerCase()),
    );
    expect(stale).toEqual([]);
  });
});

describe("values that can drift", () => {
  for (const file of docFiles()) {
    const name = relative(REPO, file);
    const text = readFileSync(file, "utf8");
    test(`${name}: image digest and TEE measurements match engine/tee/measurements.json`, () => {
      for (const d of text.match(/sha256:[0-9a-f]{64}/g) ?? []) {
        if (
          /policy|policy_set/i.test(text.slice(Math.max(0, text.indexOf(d) - 80), text.indexOf(d)))
        )
          continue;
        expect(d).toBe(measurements.oci_digest);
      }
      for (const t of text.match(/tdx:[0-9a-f]{64}/g) ?? []) expect(t).toBe(measurements.tdx.id);
      for (const n of text.match(/nitro:[0-9a-f]{64}/g) ?? [])
        expect(n).toBe(measurements.nitro.id);
    });
    test(`${name}: contract addresses are deployed ones`, () => {
      const lines = text.split("\n").filter((l) => CONTRACT_LINE.test(l));
      for (const a of lines.flatMap((l) => l.match(/0x[0-9a-fA-F]{40}\b/g) ?? [])) {
        expect(contracts.has(a.toLowerCase()), `${a} in ${name}`).toBe(true);
      }
    });
  }
});
