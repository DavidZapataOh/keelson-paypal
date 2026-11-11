import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { receiptOf } from "../src/codec.ts";
import { verifyAlibi } from "../src/verify/index.ts";
import { fixtures } from "./fixtures.ts";

const snapshot = JSON.parse(
  readFileSync(new URL("./fixtures/v1-reports.json", import.meta.url), "utf8"),
);
const now = new Date("2026-11-10T00:00:00Z");

test.each(
  fixtures.flatMap(
    (f) =>
      [
        [f.id, "bundle"],
        [f.id, "receipt"],
      ] as const,
  ),
)("the v1 report of %s (%s) is unchanged", async (id, kind) => {
  const f = fixtures.find((x) => x.id === id);
  if (!f) throw new Error(id);
  const r = await verifyAlibi(kind === "bundle" ? f.bundle : receiptOf(f.bundle), { now });
  const got = r.checks
    .filter(
      (c) => !["scitt.statement", "scitt.receipt", "rats.cmw", "card.statements"].includes(c.id),
    )
    .map((c) => ({ id: c.id, status: c.status, reads: c.reads, reason: c.reason ?? null }));
  expect(got).toEqual(snapshot[`${id}/${kind}`]);
});
