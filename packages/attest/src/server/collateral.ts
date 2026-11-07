import { type Collateral, getCollateral as fetchCollateral, PHALA_PCCS_URL } from "@phala/dcap-qvl";

/**
 * Fetches the Intel collateral a quote needs from a PCCS (Phala's by default). It is shipped with
 * the attestation so a verifier needs no network.
 */
export function getCollateral(
  quote: Uint8Array,
  pccsUrl: string = PHALA_PCCS_URL,
): Promise<Collateral> {
  return fetchCollateral(pccsUrl, quote);
}
