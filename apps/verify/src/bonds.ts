import { addresses, logBondAbi } from "@keelson/chain";
import {
  type Address,
  createPublicClient,
  decodeFunctionData,
  erc20Abi,
  fallback,
  type Hex,
  hexToString,
  http,
  keccak256,
  stringToBytes,
} from "viem";
import { arbitrumSepolia } from "viem/chains";

const RPCS = [
  "https://sepolia-rollup.arbitrum.io/rpc",
  "https://arbitrum-sepolia-rpc.publicnode.com",
];
const PYUSD = "0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1";
const ORIGINS = ["log.keelson.finance/alibi/2026-1", "log.keelson.finance/conformance/2026-1"];

export interface BondView {
  address: Address;
  origin: string;
  key: Hex;
  balance: bigint;
  /** Whether the bond calls the registry's `Ed25519Verifier` over PYUSD. */
  canonical: boolean;
  slash: {
    prover: Address;
    amount: bigint;
    bounty: bigint;
    size: bigint;
    rootA: Hex;
    rootB: Hex;
    provenAt: number;
    tx: Hex | null;
    notes: [string, string] | null;
  } | null;
}

/**
 * Every `LogBond` on Arbitrum Sepolia, read from the chain through `rpc` (or the public RPCs), never
 * from Keelson's API: its key, what it holds and, once slashed, the two signed checkpoints that
 * slashed it.
 */
export async function readBonds(rpc?: string): Promise<BondView[]> {
  const client = createPublicClient({
    chain: arbitrumSepolia,
    batch: { multicall: true },
    transport: fallback((rpc ? [rpc] : RPCS).map((u) => http(u, { timeout: 10_000 }))),
  });
  const bonds = Object.entries(addresses[421614])
    .filter(([name]) => name.startsWith("LogBond"))
    .map(([, a]) => a as Address);
  return Promise.all(
    bonds.map(async (address) => {
      const c = { address, abi: logBondAbi } as const;
      const [origin, key, token, verifier, e] = await Promise.all([
        client.readContract({ ...c, functionName: "origin" }),
        client.readContract({ ...c, functionName: "key" }),
        client.readContract({ ...c, functionName: "token" }),
        client.readContract({ ...c, functionName: "verifier" }),
        client.readContract({ ...c, functionName: "equivocation" }),
      ]);
      const balance = await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      });
      let slash: BondView["slash"] = null;
      if (e.prover !== "0x0000000000000000000000000000000000000000") {
        const [log] = await client.getContractEvents({
          ...c,
          eventName: "EquivocationProven",
          fromBlock: e.l2Block,
          toBlock: e.l2Block,
        });
        let notes: [string, string] | null = null;
        if (log) {
          const tx = await client.getTransaction({ hash: log.transactionHash });
          const [a, b] = decodeFunctionData({ abi: logBondAbi, data: tx.input }).args as readonly [
            Hex,
            Hex,
          ];
          notes = [hexToString(a), hexToString(b)];
        }
        slash = {
          prover: e.prover,
          amount: e.amount,
          bounty: e.bounty,
          size: e.size,
          rootA: e.rootA,
          rootB: e.rootB,
          provenAt: e.provenAt,
          tx: log?.transactionHash ?? null,
          notes,
        };
      }
      return {
        address,
        origin: ORIGINS.find((o) => keccak256(stringToBytes(o)) === origin) ?? origin,
        key,
        balance,
        canonical: verifier === addresses[421614].Ed25519Verifier && token === PYUSD,
        slash,
      };
    }),
  );
}
