/**
 * Exports every fixture Alibi to AP2 and Verifiable Intent with fresh P-256 keys, and writes what
 * `verify.py` hands to the projects' reference verifiers. The fixtures' mandates delegate to
 * Keelson's hosted agent, whose key stays on the API: each export is closed by a fresh agent key
 * that replaces the mandate's `cnf` before the open mandates are issued.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { decodeAlibi } from "@keelson/alibi";
import { exportJWK, generateKeyPair } from "jose";
import { ap2Receipts, checkoutJwt, closeAp2, instrumentOf, issueAp2Open } from "../src/ap2.ts";
import { purchaseFacts } from "../src/facts.ts";
import { type EcPublicJwk, type Signer, signerOf } from "../src/jose.ts";
import { closeVi, issueViL2 } from "../src/vi.ts";

async function freshSigner(): Promise<Signer> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  return signerOf(privateKey, (await exportJWK(publicKey)) as EcPublicJwk);
}

const fixtures = new URL("../test/fixtures/", import.meta.url);
const out = [];
for (const file of readdirSync(fixtures).filter((f) => f.endsWith(".alibi"))) {
  const b = decodeAlibi(readFileSync(new URL(file, fixtures)));
  const keelson = await freshSigner();
  const agent = await freshSigner();
  const f = purchaseFacts(b);
  const mandate = {
    ...f.mandate,
    agent: { ...f.mandate.agent, cnf: { jwk: { ...agent.jwk, kid: agent.kid } } },
  };
  const facts = { ...f, mandate };
  const nonce = "conformance-nonce";
  const iat = facts.issuedAt;
  const open = await issueAp2Open(mandate, keelson, {
    mandateHash: facts.mandateHash,
    instrument: instrumentOf(mandate),
  });
  const cjwt = await checkoutJwt(facts, keelson);
  const closed = await closeAp2(open, facts, cjwt, agent, { nonce, iat });
  const receipts = await ap2Receipts(closed, facts, keelson, {
    iss: "https://keelson.finance",
    iat,
  });
  const vi = await issueViL2(mandate, keelson, {
    mandateHash: facts.mandateHash,
    iss: "https://keelson.finance",
    instrument: instrumentOf(mandate),
    ...(facts.payee ? { payee: facts.payee } : {}),
  });
  const l3 = await closeVi(vi, facts, cjwt, agent, {
    nonce,
    iat,
    networkAud: "https://www.paypal.com",
    merchantAud: facts.merchant.website ?? facts.merchant.id,
  });
  out.push({
    alibi: b.alibi_id,
    decision: facts.decision,
    now: iat,
    keelson_jwk: keelson.jwk,
    ap2: { open, closed, receipts, nonce },
    vi: {
      ...vi,
      ...l3,
      network_aud: "https://www.paypal.com",
      merchant_aud: facts.merchant.website ?? facts.merchant.id,
      nonce,
    },
  });
}
writeFileSync(new URL("exports.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(`exported ${out.length} Alibis`);
