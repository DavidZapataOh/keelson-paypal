import { readFileSync } from "node:fs";
import { decodeAlibi } from "../src/codec.ts";
import type { AlibiBundle } from "../src/schema.ts";

export interface Fixture {
  id: string;
  mode: "2of2" | "degraded";
  anchored: boolean;
  captured: string;
  bytes: Uint8Array;
  bundle: AlibiBundle;
}

const dir = new URL("./fixtures/", import.meta.url);

/** Real Alibis of sandbox purchases, captured by `scripts/capture-fixtures.ts`. */
export const fixtures: Fixture[] = (
  JSON.parse(readFileSync(new URL("fixtures.json", dir), "utf8")) as Omit<
    Fixture,
    "bytes" | "bundle"
  >[]
).map((f) => {
  const bytes = new Uint8Array(readFileSync(new URL(`${f.id}.alibi`, dir)));
  return { ...f, bytes, bundle: decodeAlibi(bytes) };
});

/** A deep copy to edit one field of. */
export const copy = (b: AlibiBundle): AlibiBundle => structuredClone(b);
