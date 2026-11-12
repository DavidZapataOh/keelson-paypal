import type { EcPublicJwk } from "./signer.ts";

/**
 * The enclave issuer's keys: leg A's attested ES256 issuer key, whose RFC 7638 thumbprint both
 * legs bind into their attestation's `report_data`, current first, then retired ones.
 */
export const EXPORT_ISSUER_KEYS: EcPublicJwk[] = [];

/** The hosted agent's Ed25519 keys for RFC 9421 requests, current first, then retired ones. */
export const AGENT_HTTP_KEYS: object[] = [];
