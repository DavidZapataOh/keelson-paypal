import type { AttestedBinding } from "@keelson/attest";
import { hashKeelson, keelsonDomain, reportData } from "@keelson/core/eip712";
import {
  type Address,
  type Hex,
  isAddressEqual,
  keccak256,
  recoverAddress,
  stringToHex,
} from "viem";

/** The `WebFact` leg A signs for a TLS session it notarized, as the prover returns it. */
export interface SignedWebFact {
  web_fact: {
    hostHash: Hex;
    urlPathHash: Hex;
    tCapture: number;
    rangeCommitment: Hex;
    attId: Hex;
  };
  chain_id: number;
  digest: Hex;
  signature: Hex;
  signer: Address;
}

export class WebFactError extends Error {
  readonly code: "signature" | "signer" | "url" | "attestation";
  constructor(code: WebFactError["code"]) {
    super(code);
    this.code = code;
  }
}

/**
 * Checks that `signed` is a `WebFact` over `url` signed by the active leg A signer: the digest is
 * the EIP-712 hash of the fact, it recovers to that signer, the hashes name the URL's host and
 * target, and `attId` is the signer binding its attestation covers.
 */
export async function verifyWebFact(
  signed: SignedWebFact,
  url: URL,
  signer: { address: Address; binding: AttestedBinding },
  verifyingContract: Address,
): Promise<void> {
  const f = signed.web_fact;
  const digest = hashKeelson(
    "WebFact",
    {
      hostHash: f.hostHash,
      urlPathHash: f.urlPathHash,
      tCapture: f.tCapture,
      rangeCommitment: f.rangeCommitment,
      attId: f.attId,
    },
    keelsonDomain(signed.chain_id as 421614, verifyingContract),
  );
  if (digest !== signed.digest.toLowerCase()) throw new WebFactError("signature");
  const recovered = await recoverAddress({ hash: digest, signature: signed.signature });
  if (!isAddressEqual(recovered, signed.signer)) throw new WebFactError("signature");
  if (!isAddressEqual(recovered, signer.address)) throw new WebFactError("signer");
  if (
    f.hostHash.toLowerCase() !== keccak256(stringToHex(url.hostname)) ||
    f.urlPathHash.toLowerCase() !== keccak256(stringToHex(`${url.pathname}${url.search}`))
  ) {
    throw new WebFactError("url");
  }
  const b = signer.binding;
  const attId = reportData(
    {
      chainId: BigInt(b.chainId),
      bondVault: b.bondVault,
      teeKind: b.teeKind,
      signer: b.signer,
      policySetHash: b.policySetHash,
      engineBuildId: b.engineBuildId,
      bootEpoch: BigInt(b.bootEpoch),
      issuerJwkThumbprint: b.issuerJwkThumbprint,
    },
    `0x${"00".repeat(32)}`,
  ).slice(0, 66);
  if (f.attId.toLowerCase() !== attId.toLowerCase()) throw new WebFactError("attestation");
}
