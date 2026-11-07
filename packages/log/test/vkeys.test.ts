import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { LOG_ORIGINS, LOG_VKEYS } from "../src/index.ts";

const read = (name: string) =>
  readFileSync(new URL(`../../../services/log/keys/${name}`, import.meta.url), "utf8").trim();

test("the verifier keys are the log's committed keys", () => {
  expect(LOG_VKEYS[LOG_ORIGINS[421614] as string]).toEqual([
    read("alibi-2026-1.vkey"),
    read("alibi-2026-1.mldsa.vkey"),
  ]);
  expect(LOG_VKEYS[LOG_ORIGINS[42161] as string]).toEqual([
    read("alibi-live-2026-1.vkey"),
    read("alibi-live-2026-1.mldsa.vkey"),
  ]);
});
