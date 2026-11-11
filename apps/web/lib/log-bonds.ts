import { get } from "./api";

/** `GET /v1/log/bonds`: public. */
export interface LogBond {
  chainId: number;
  address: string;
  origin: string;
  /** A test origin's bond, slashed by the equivocation drill. */
  test: boolean;
  key: string;
  owner: string;
  verifier: string;
  /** Whether the bond calls the registry's Ed25519 verifier over PYUSD. */
  canonical: boolean;
  beneficiary: string;
  bountyBps: number;
  completionWindowSeconds: number;
  balanceMinor: string;
  withdrawalDelaySeconds: number;
  withdrawal: { amountMinor: string; unlockAt: string; to: string } | null;
  equivocation: {
    prover: string;
    amountMinor: string;
    bountyMinor: string;
    provenAt: string;
    size: string;
    rootA: string;
    rootB: string;
    noteA: string | null;
    noteB: string | null;
    txHash: string | null;
    explorerUrl: string | null;
  } | null;
  explorerUrl: string;
}

export const logBonds = () => get<{ bonds: LogBond[] }>("/v1/log/bonds");

/** PYUSD has six decimals. */
export function pyusd(minor: string): string {
  const n = Number(BigInt(minor)) / 1e6;
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })} PYUSD`;
}
