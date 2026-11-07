import { readFileSync } from "node:fs";
import type { Hex } from "viem";

interface Captured<T> {
  capturedAt: string;
  leg: string;
  sha256: string;
  attestation: T;
}

export interface Binding {
  chainId: string;
  bondVault: Hex;
  teeKind: 1 | 2;
  signer: Hex;
  policySetHash: Hex;
  engineBuildId: Hex;
  bootEpoch: string;
  issuerJwkThumbprint: Hex;
}

export interface NitroEvidence
  extends Captured<{
    tee: "nitro";
    document: string;
    binding: Binding;
    block: { number: number; hash: Hex };
  }> {}

export interface TdxEvidence
  extends Captured<{
    tee: "tdx";
    quote: string;
    event_log: {
      imr: number;
      event_type: number;
      digest: string;
      event: string;
      event_payload: string;
    }[];
    binding: Binding;
    block: { number: number; hash: Hex };
    app_id: string;
    compose_hash: string;
    dstack_version: string;
  }> {
  collateral: import("@phala/dcap-qvl").Collateral;
}

const read = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(`./evidence/${name}`, import.meta.url), "utf8")) as T;

export const nitroEvidence = read<NitroEvidence>("nitro-leg-b.json");
export const tdxEvidence = read<TdxEvidence>("tdx-leg-a.json");
