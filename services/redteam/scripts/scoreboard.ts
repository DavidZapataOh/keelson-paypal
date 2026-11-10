/**
 * Recomputes a red-team campaign's scoreboard from its downloaded ledger:
 *
 *   node services/redteam/scripts/scoreboard.ts <campaign>.jsonl
 *
 * It first verifies the ledger (the hash chain, every Keelson trace and judge verdict, and the
 * summary), then prints the scoreboard in its JCS form, byte for byte what the API publishes.
 */
import { readFile } from "node:fs/promises";
import { jcs } from "@keelson/core";
import { verify } from "../src/ledger.ts";
import { score } from "../src/scoreboard.ts";

const [path] = process.argv.slice(2);
if (!path) {
  process.stderr.write("usage: scoreboard.ts <ledger.jsonl>\n");
  process.exit(2);
}
const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l !== "");
const checked = verify(lines);
if (!checked.ok) {
  process.stderr.write(`the ledger does not verify:\n${checked.errors.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(jcs(score(lines) as never));
