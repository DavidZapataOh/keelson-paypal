// Writes the vectors the Python SDK checks itself against, from the TypeScript packages.
import { writeFileSync } from "node:fs";
import { cartHash, toHex } from "@keelson/core";
import { buildManifest, canonicalBytes, MEDIA_TYPES } from "@keelson/evidence";
import { closeMandate } from "@keelson/mandate";
import { Keelson, tools } from "../src/index.ts";

const cart = {
  merchant: "mrc_runfast",
  currency: "USD",
  lines: [{ sku: "RF-CLD", size: "10", category: "shoes", qty: 1, unit_minor: 11_900 }],
  return_days: 30,
  returns_free: true,
};
const product = {
  handle: "cloud-daily",
  price: { minor: 11_900, display: "$119.00" },
  rating: 4.5,
};
const observation = "Cloud Daily, size 10, $119.00 — in stock.";
const salt = (b: number) => new Uint8Array(32).fill(b);
const items = [
  {
    type: "api.product",
    mediaType: MEDIA_TYPES["api.product"],
    bytes: canonicalBytes(product),
    salt: salt(1),
  },
  {
    type: "api.cart",
    mediaType: MEDIA_TYPES["api.cart"],
    bytes: canonicalBytes(cart),
    salt: salt(2),
  },
  {
    type: "llm.observation",
    mediaType: MEDIA_TYPES["llm.observation"],
    bytes: new TextEncoder().encode(observation),
    salt: salt(3),
  },
] as const;

// A test key, fixed so the vectors are the same on every run.
const jwk = {
  kty: "EC",
  crv: "P-256",
  x: "JrAfWsb8MsZtTq5MMorFci0dPpnGXEh05PdgVV-5mfA",
  y: "UyCtE_QUg2dMzkn4-64sxVXOTuNRmI36q795lVKz2v4",
  d: "xXfaHcH4eIARMTj59sz1LDlyGYocsUXs9Ejb3WNd8cA",
};
const privateKey = await crypto.subtle.importKey(
  "jwk",
  jwk,
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["sign"],
);
const jwt = (payload: object) =>
  `${Buffer.from('{"alg":"ES256"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`;
const open = `${jwt({ iss: "a" })}~WyJhIl0~~${jwt({ _sd_alg: "sha-256", iss: "b" })}~WyJiIl0~`;
const requestId = "01JC3XQ7ZK8M4N6P9R2T5V7W0Y";
const iat = 1_800_000_000;
const closed = await closeMandate(
  open,
  { requestId, cartHash: `sha256:${toHex(cartHash(cart)).slice(2)}`, iat },
  privateKey,
);

const vectors = {
  cart,
  product,
  observation,
  canonical: { product: Buffer.from(canonicalBytes(product)).toString("hex") },
  cartHash: `sha256:${toHex(cartHash(cart)).slice(2)}`,
  manifest: buildManifest([...items]),
  close: {
    open,
    requestId,
    iat,
    jwk,
    keyBinding: closed.slice(open.length).split(".").slice(0, 2).join("."),
  },
  tools: tools(new Keelson({ auth: null })).map((t) => ({
    name: t.name,
    readOnly: t.readOnly,
    inputSchema: t.inputSchema,
  })),
};
// The Python SDK's tools carry these names, descriptions and schemas verbatim.
writeFileSync(
  new URL("../../sdk-python/src/keelson/_tools.json", import.meta.url),
  `${JSON.stringify(
    tools(new Keelson({ auth: null })).map((t) => ({
      name: t.name,
      description: t.description,
      readOnly: t.readOnly,
      inputSchema: t.inputSchema,
    })),
    null,
    2,
  )}\n`,
);
writeFileSync(
  new URL("../../sdk-python/tests/vectors.json", import.meta.url),
  `${JSON.stringify(vectors, null, 2)}\n`,
);
