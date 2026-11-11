/**
 * Seals the live WebFact of `c2b-live.json` as the agent seals it into a purchase's evidence, and
 * writes the opening `AmberContradictionCourt` takes to `c2b-live-evidence.json`.
 *
 *   node contracts/test/vectors/amber-evidence.ts
 *
 * The evidence holds `api.product`, `api.cart`, `llm.observation` and the `tlsn.web_fact` item, the
 * JCS of `{ url, web_fact, chain_id, digest, signature, signer, committed, blinder }`; the opening is
 * the item's bytes, salt and RFC 9162 path, as an Alibi discloses it.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Json, jcs, toHex } from "../../../packages/core/src/index.ts";
import { buildManifest, disclose, type SealedItem } from "../../../packages/evidence/src/index.ts";

const here = import.meta.dirname;
const live = JSON.parse(readFileSync(join(here, "c2b-live.json"), "utf8"));
const encode = (s: string) => new TextEncoder().encode(s);
/** Fixed salts, so the vector is reproducible. */
const salt = (name: string) => new Uint8Array(createHash("sha256").update(`salt/${name}`).digest());

const document = jcs({
  url: live.url,
  web_fact: live.webFact,
  chain_id: 421614,
  digest: live.digest,
  signature: live.signature,
  signer: live.signer,
  committed: live.committed,
  blinder: live.blinder,
} as Json);

const items: SealedItem[] = [
  {
    type: "api.product",
    mediaType: "application/json",
    bytes: encode(jcs({ handle: "tempo-3", sku: "RF-TMP3", sizes: ["10", "11"] })),
    salt: salt("api.product"),
  },
  {
    type: "api.cart",
    mediaType: "application/json",
    bytes: encode(jcs({ merchant: "mrc_runfast", lines: [{ sku: "RF-TMP3-11" }] })),
    salt: salt("api.cart"),
  },
  {
    type: "llm.observation",
    mediaType: "text/plain; charset=utf-8",
    bytes: encode("Tempo 3, size 11, blue."),
    salt: salt("llm.observation"),
  },
  {
    type: "tlsn.web_fact",
    mediaType: "application/json",
    bytes: encode(document),
    salt: salt("tlsn.web_fact"),
  },
];
const manifest = buildManifest(items);
const d = disclose(items, 3);

writeFileSync(
  join(here, "c2b-live-evidence.json"),
  `${JSON.stringify(
    {
      root: manifest.root,
      item: {
        document: toHex(encode(document)),
        salt: d.salt,
        index: d.index,
        size: d.size,
        path: d.path,
        digestAt: document.indexOf('"digest":"'),
      },
    },
    null,
    2,
  )}\n`,
);
