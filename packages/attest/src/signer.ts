import { reportData, type SignerBinding, TeeKind } from "@keelson/core/eip712";
import { type Address, getAddress, type Hex, hexToBytes, keccak256, type PublicClient } from "viem";
import { AttestationCache } from "./cache.ts";
import { AttestError } from "./errors.ts";
import type { DstackEvent } from "./eventlog.ts";
import { nitroMeasurement, tdxMeasurement } from "./measurement.ts";
import { verifyNitro } from "./nitro.ts";
import { appraiseTd } from "./policy.ts";
import { type Collateral, verifyTdx } from "./tdx.ts";
import type { Validity } from "./validity.ts";

/** A signer binding as the engine serves it: numbers that exceed 53 bits are decimal strings. */
export interface AttestedBinding {
  chainId: string;
  bondVault: Address;
  teeKind: 1 | 2;
  signer: Address;
  policySetHash: Hex;
  engineBuildId: Hex;
  bootEpoch: string;
  issuerJwkThumbprint: Hex;
}

export interface AttestedBlock {
  number: number | string;
  hash: Hex;
}

/** What `/v1/attestation` serves, plus the Intel collateral for a TDX quote. */
export type SignerAttestation =
  | {
      tee: "tdx";
      /** The TDX quote, hex. */
      quote: string;
      eventLog: DstackEvent[];
      collateral: Collateral;
      binding: AttestedBinding;
      block: AttestedBlock;
    }
  | {
      tee: "nitro";
      /** The COSE_Sign1 attestation document, base64. */
      document: string;
      binding: AttestedBinding;
      block: AttestedBlock;
    };

export interface Expectations {
  chainId: number;
  bondVault: Address;
  policySetHash: Hex;
  engineBuildId: Hex;
  /** Measurement ids (`tdx:...`, `nitro:...`) the relying party accepts. */
  measurements: readonly string[];
  now: Date;
  /** When set, the attested block hash is read from the chain and must be less than an hour old. */
  rpc?: PublicClient;
  /** When set, the issuer key the attestation must commit to. */
  issuerJwkThumbprint?: Hex;
  /** The TDX devices allowed; `TDX_DEVICES` by default. */
  tdxDevices?: readonly Hex[];
  /** When set, a platform verification of the same evidence and allowlist is reused while valid. */
  cache?: AttestationCache;
}

export interface VerifiedSigner {
  signer: Address;
  teeKind: 1 | 2;
  measurement: string;
  bootEpoch: bigint;
  block: { number: bigint; hash: Hex };
  issuerJwkThumbprint: Hex;
  tcbStatus?: string;
  advisoryIds?: string[];
}

/** The Ethereum address of a SEC1 uncompressed secp256k1 public key. */
function addressOf(key: Hex): Hex {
  if (key.length !== 132 || !key.startsWith("0x04")) throw mismatch("the attested key is not SEC1");
  return `0x${keccak256(`0x${key.slice(4)}`).slice(26)}`;
}

const MAX_BLOCK_AGE_MS = 3_600_000;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const mismatch = (message: string) => new AttestError("binding_mismatch", message);

function fromBinding(b: AttestedBinding): SignerBinding {
  return {
    chainId: BigInt(b.chainId),
    bondVault: b.bondVault,
    teeKind: b.teeKind,
    signer: b.signer,
    policySetHash: b.policySetHash,
    engineBuildId: b.engineBuildId,
    bootEpoch: BigInt(b.bootEpoch),
    issuerJwkThumbprint: b.issuerJwkThumbprint,
  };
}

interface Platform {
  reportData: Hex;
  measurement: string;
  extra: { tcbStatus?: string; advisoryIds?: string[] };
}

/** The platform evidence checked, and what it attests about `report_data`. */
async function platform(
  att: SignerAttestation,
  now: Date,
  tdxDevices?: readonly Hex[],
): Promise<Platform & { validity: Validity }> {
  if (att.tee === "tdx") {
    const bytes = hexToBytes(`0x${att.quote}`);
    const tdx = await verifyTdx(
      { quote: bytes, eventLog: att.eventLog, collateral: att.collateral },
      { now },
    );
    appraiseTd(tdx, tdxDevices ? { devices: tdxDevices } : {});
    return {
      reportData: tdx.reportData,
      measurement: tdxMeasurement(tdx),
      extra: { tcbStatus: tdx.tcbStatus, advisoryIds: tdx.advisoryIds },
      validity: tdx.validity,
    };
  }
  const nitro = await verifyNitro(
    Uint8Array.from(atob(att.document), (c) => c.charCodeAt(0)),
    { now },
  );
  if (!nitro.userData || !nitro.publicKey || !nitro.nonce) {
    throw mismatch("the document lacks user_data, public_key or nonce");
  }
  if (!same(addressOf(nitro.publicKey), att.binding.signer)) {
    throw mismatch("the attested public key is not the signer");
  }
  if (!same(nitro.nonce, att.block.hash))
    throw mismatch("the document nonce is not the block hash");
  return {
    reportData: nitro.userData,
    measurement: nitroMeasurement(nitro),
    extra: {},
    validity: nitro.validity,
  };
}

/** {@link platform}, through `expect.cache` when set. */
async function cachedPlatform(att: SignerAttestation, expect: Expectations): Promise<Platform> {
  const { cache, now } = expect;
  if (!cache) return platform(att, now, expect.tdxDevices);
  const key = AttestationCache.key(att, [...expect.measurements, ...(expect.tdxDevices ?? [])]);
  const hit = cache.get<Platform>(key, now);
  if (hit) return hit;
  const { validity, ...verified } = await platform(att, now, expect.tdxDevices);
  if (expect.measurements.includes(verified.measurement)) cache.set(key, verified, validity);
  return verified;
}

async function checkBlock(att: SignerAttestation, expect: Expectations, rpc: PublicClient) {
  const block = await rpc.getBlock({ blockNumber: BigInt(att.block.number) });
  if (!same(block.hash, att.block.hash)) throw mismatch("the block hash is not the chain's");
  if (expect.now.getTime() - Number(block.timestamp) * 1000 > MAX_BLOCK_AGE_MS) {
    throw new AttestError("stale_block", "the attested block is more than an hour old");
  }
}

/**
 * Verifies a leg's platform evidence, that its `report_data` binds the signer, chain, bond vault,
 * policy set, build and issuer the caller expects, and that its measurement is allowed.
 */
export async function verifySigner(
  att: SignerAttestation,
  expect: Expectations,
): Promise<VerifiedSigner> {
  const verified = await cachedPlatform(att, expect);

  const b = att.binding;
  const kind = att.tee === "tdx" ? TeeKind.TDX : TeeKind.NITRO;
  if (b.teeKind !== kind) throw mismatch("the binding names another TEE kind");
  if (!same(reportData(fromBinding(b), att.block.hash), verified.reportData)) {
    throw mismatch("report_data does not bind this signer, build and block");
  }
  if (BigInt(b.chainId) !== BigInt(expect.chainId)) throw mismatch("chainId differs");
  if (!same(getAddress(b.bondVault), getAddress(expect.bondVault)))
    throw mismatch("bondVault differs");
  if (!same(b.policySetHash, expect.policySetHash)) throw mismatch("policySetHash differs");
  if (!same(b.engineBuildId, expect.engineBuildId)) throw mismatch("engineBuildId differs");
  if (expect.issuerJwkThumbprint && !same(b.issuerJwkThumbprint, expect.issuerJwkThumbprint)) {
    throw mismatch("issuerJwkThumbprint differs");
  }

  if (!expect.measurements.includes(verified.measurement)) {
    throw new AttestError("measurement_not_allowed", `${verified.measurement} is not allowed`);
  }
  if (expect.rpc) await checkBlock(att, expect, expect.rpc);

  return {
    signer: getAddress(b.signer),
    teeKind: kind,
    measurement: verified.measurement,
    bootEpoch: BigInt(b.bootEpoch),
    block: { number: BigInt(att.block.number), hash: att.block.hash },
    issuerJwkThumbprint: b.issuerJwkThumbprint,
    ...verified.extra,
  };
}

/** Verifies both legs and requires them to attest the same credential issuer. */
export async function verifyLegs(
  a: readonly [SignerAttestation, Expectations],
  b: readonly [SignerAttestation, Expectations],
): Promise<[VerifiedSigner, VerifiedSigner]> {
  const [first, second] = await Promise.all([verifySigner(...a), verifySigner(...b)]);
  if (!same(first.issuerJwkThumbprint, second.issuerJwkThumbprint)) {
    throw mismatch("the legs attest different issuers");
  }
  return [first, second];
}
