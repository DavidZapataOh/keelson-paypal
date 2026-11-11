/**
 * Writes the exports of the production Alibi fixtures to `out/`, issued and closed with fresh test
 * keys, for `verify.py` to check with the standards' reference verifiers.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { exportAp2 } from "../src/ap2.ts";
import { exportUcp } from "../src/ucp.ts";
import {
  ALLOW_CARD,
  ALLOW_PAYPAL,
  DENY_PAYPAL,
  factsFor,
  NOW,
  refFor,
  testAgent,
  testIssuer,
} from "../test/fixtures.ts";

const out = new URL("./out/", import.meta.url);
mkdirSync(out, { recursive: true });
for (const id of [ALLOW_PAYPAL, DENY_PAYPAL, ALLOW_CARD]) {
  const issuer = await testIssuer(id);
  const agent = await testAgent();
  const f = factsFor(id, agent);
  const ap2 = await exportAp2(f, refFor(id), { issuer, agent }, { now: NOW });
  writeFileSync(
    new URL(`${id}.json`, out),
    `${JSON.stringify(
      {
        alibi: id,
        decision: f.decision,
        cart_disclosed: f.lines !== undefined,
        now: NOW,
        issuer_jwk: issuer.jwk,
        ap2,
      },
      null,
      2,
    )}\n`,
  );
  if (f.decision === "allow" && f.lines) {
    const ucp = await exportUcp(f, refFor(id), { issuer, agent }, { now: NOW });
    writeFileSync(
      new URL(`${id}.ucp-checkout.json`, out),
      `${JSON.stringify(ucp.checkout, null, 2)}\n`,
    );
  }
}
console.log("wrote the exports");
