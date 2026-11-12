import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { REPO } from "./lib/markdown";

const fixtures = JSON.parse(
  readFileSync(join(REPO, "packages/alibi/test/fixtures/fixtures.json"), "utf8"),
) as {
  id: string;
  mode: string;
}[];
const PROOFS = [
  "tee.attestation.tdx",
  "tee.attestation.nitro",
  "tee.countersign",
  "log.inclusion",
  "log.witnesses",
  "anchor.root",
  "paypal.ids",
];

describe("the sample Alibis the docs use", () => {
  for (const f of fixtures) {
    test(`${f.id} verifies as ${f.mode}`, { timeout: 120_000 }, async () => {
      const res = await fetch("https://api.keelson.finance/v1/alibis/verify", {
        method: "POST",
        headers: {
          "content-type": "application/vnd.keelson.alibi.v1+json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: readFileSync(join(REPO, "packages/alibi/test/fixtures", `${f.id}.alibi`)),
      });
      const report = (await res.json()) as {
        verdict: string;
        mode: string;
        checks: { id: string; status: string }[];
      };
      expect(report.verdict).toBe("verified");
      expect(report.mode).toBe(f.mode);
      if (f.mode === "2of2") {
        for (const id of PROOFS)
          expect(report.checks.find((c) => c.id === id)?.status, id).toBe("pass");
      }
    });
  }
});
