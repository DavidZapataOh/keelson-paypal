import type { Db } from "@keelson/db";
import type { Hex } from "viem";
import { activeSigner } from "./tee/signers.ts";

/** The thumbprint of the credential issuer key leg A's active signer attests; `null` without one. */
export async function currentIssuer(db: Db): Promise<Hex | null> {
  return (await activeSigner(db, 1))?.binding.issuerJwkThumbprint ?? null;
}

/**
 * Whether leg A no longer holds the issuer key a mandate was issued with: after the key moved,
 * its open mandate no longer verifies there, and the user signs it again.
 */
export function needsRenewal(issuerThumbprint: string | null, current: Hex | null): boolean {
  return (
    issuerThumbprint !== null &&
    current !== null &&
    issuerThumbprint.toLowerCase() !== current.toLowerCase()
  );
}
