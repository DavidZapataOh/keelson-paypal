/**
 * Scores a run of the checkout-attack corpus (`ATTACK_RESULTS` of `services/agent`'s
 * `test/attacks.test.ts`) and prints the scoreboard in its JCS form, byte for byte what
 * `/redteam/checkout-attacks.json` publishes:
 *
 *   node services/redteam/scripts/checkout-scoreboard.ts <attacks.jsonl>
 */
import { readFile } from "node:fs/promises";
import { jcs } from "@keelson/core";
import { type CheckoutResult, scoreCheckout } from "../src/checkout.ts";

const [path] = process.argv.slice(2);
if (!path) {
  process.stderr.write("usage: checkout-scoreboard.ts <attacks.jsonl>\n");
  process.exit(2);
}
const results = (await readFile(path, "utf8"))
  .split("\n")
  .filter((l) => l !== "")
  .map((l) => JSON.parse(l) as CheckoutResult);
process.stdout.write(jcs(scoreCheckout(results) as never));
