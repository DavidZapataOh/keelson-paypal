/**
 * Records real Alibis as test fixtures: `test/fixtures/<alibi_id>.alibi` and their entry in
 * `fixtures.json`.
 *
 * ```sh
 * node scripts/capture-fixtures.ts --from-api <alibi_id>…   # with KEELSON_API_TOKEN
 * ```
 *
 * The live issue test calls {@link writeFixture} for the purchases it drives.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { decodeAlibi, encodeAlibi } from "../src/codec.ts";
import type { AlibiBundle } from "../src/schema.ts";

export interface FixtureEntry {
  id: string;
  mode: "2of2" | "degraded";
  anchored: boolean;
  captured: string;
}

const dir = new URL("../test/fixtures/", import.meta.url);
const index = new URL("fixtures.json", dir);

export function readFixtures(): FixtureEntry[] {
  try {
    return JSON.parse(readFileSync(index, "utf8")) as FixtureEntry[];
  } catch {
    return [];
  }
}

/** Writes a bundle's canonical bytes and lists it, replacing an earlier capture of its id. */
export function writeFixture(b: AlibiBundle): void {
  writeFileSync(new URL(`${b.alibi_id}.alibi`, dir), encodeAlibi(b));
  const entry: FixtureEntry = {
    id: b.alibi_id,
    mode: b.tee.mode,
    anchored: b.anchor !== undefined,
    captured: new Date().toISOString().slice(0, 10),
  };
  const all = [...readFixtures().filter((f) => f.id !== b.alibi_id), entry];
  writeFileSync(index, `${JSON.stringify(all, null, 2)}\n`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] !== "--from-api" || args.length < 2) {
    console.error("usage: capture-fixtures.ts --from-api <alibi_id>…");
    process.exit(2);
  }
  const api = process.env.KEELSON_API_URL ?? "https://api.keelson.finance";
  for (const id of args.slice(1)) {
    const res = await fetch(`${api}/v1/alibis/${id}`, {
      headers: { authorization: `Bearer ${process.env.KEELSON_API_TOKEN ?? ""}` },
    });
    if (!res.ok) throw new Error(`${id}: ${res.status}`);
    writeFixture(decodeAlibi(new Uint8Array(await res.arrayBuffer())));
    console.info(`captured ${id}`);
  }
}
