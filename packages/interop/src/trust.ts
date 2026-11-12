import type { EcPublicJwk } from "./signer.ts";

/**
 * The enclave issuer's keys: leg A's attested ES256 issuer key, whose RFC 7638 thumbprint both
 * legs bind into their attestation's `report_data`, current first, then retired ones.
 */
export const EXPORT_ISSUER_KEYS: EcPublicJwk[] = [
  {
    kty: "EC",
    crv: "P-256",
    x: "yr5aTvuxQBWLgIJK6cbQOFTdFO2xDpbyvIE0acukDJw",
    y: "kHwFImNYH0nTx50xGCqjRJ4j2Nid5bM1KQ9Z4fN6cxw",
    kid: "tYaEPpafL9yGIwEvil2vKfxdV0haC4zoMkxw8U4HuUA",
  },
];

/** The hosted agent's Ed25519 keys for RFC 9421 requests, current first, then retired ones. */
export const AGENT_HTTP_KEYS: object[] = [
  {
    kty: "OKP",
    crv: "Ed25519",
    x: "9pdekk7eQjNYNXuO2CO8-VYvRFriQj4oha0NXN5sJXs",
    kid: "3e6Y4a3nacxiXiz8IsbaMpMOuN6ChW8lmWRjqOIouzE",
  },
];
