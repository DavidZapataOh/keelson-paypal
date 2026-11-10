import { checkpointAnchorAbi, honkVerifierAbi, verdictVerifierAbi } from "@keelson/chain";
import {
  type Address,
  type BaseError,
  type Chain,
  ContractFunctionRevertedError,
  createPublicClient,
  fallback,
  type Hex,
  http,
  parseEventLogs,
} from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";

/** What one verification reads from the chain its Alibi is anchored on. */
export interface ChainQuery {
  /** keccak256 of the log origin, the key `CheckpointAnchor` stores it under. */
  origin: Hex;
  /** The anchored size to read the root of; 0 when the Alibi carries no anchor. */
  size: bigint;
  signers: Address[];
  measurements: Hex[];
  /** The block each attestation names as its freshness proof. */
  blocks: bigint[];
  anchorTx?: Hex;
  /** The block the anchor transaction is stated to be in; an RPC behind it cannot answer. */
  anchorBlock?: bigint;
  anchor: Address;
  verifier: Address;
  /** A C1 proof to check with the deployed `MandatePredicateVerifier`. */
  c1?: { verifier: Address; proof: Hex; publicInputs: Hex[] };
}

interface SignerRecord {
  teeKind: number;
  registeredAt: number;
  expiresAt: number;
  revokedAt: number;
  measurement: Hex;
}

export interface ChainAnswer {
  rootAt: Hex;
  latest: { size: bigint; root: Hex; at: number };
  signers: SignerRecord[];
  allowed: boolean[];
  /** The hash of each block of `ChainQuery.blocks`. */
  blocks: Hex[];
  /** The `CheckpointAnchored` log of the anchor transaction, `null` when it holds none or does not exist. */
  anchorLog?: { origin: Hex; size: bigint; root: Hex; blockNumber: bigint } | null;
  /** Whether the deployed C1 verifier accepts `ChainQuery.c1`; absent when not asked. */
  c1?: boolean;
  /** The RPC that answered. */
  rpc: string;
  /** Whether that RPC was chosen by the caller rather than one of the public defaults. */
  custom: boolean;
}

export interface ChainReader {
  read(chainId: number, q: ChainQuery): Promise<ChainAnswer>;
}

/** The chain could not be read: transport failure, or an RPC of another chain. */
export class ChainUnreachableError extends Error {
  override name = "ChainUnreachableError";
}

const CHAINS: Record<number, { chain: Chain; rpcs: string[] }> = {
  421614: {
    chain: arbitrumSepolia,
    rpcs: ["https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia-rpc.publicnode.com"],
  },
  42161: {
    chain: arbitrum,
    rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
  },
};

export interface ChainReaderOptions {
  /** The RPCs of a chain id, tried in order, replacing the public defaults. */
  rpc?: Partial<Record<number, string | readonly string[]>>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The RPC is trusted for what it reads: no light client checks its answers, so a dishonest RPC can
 * hide a revocation or claim an anchor. What an Alibi proves offline (witnessed checkpoints,
 * consistency, attestations, countersignature) does not depend on it.
 *
 * Reads the anchor and the signer registry in one HTTP request: the contract reads go through
 * Multicall3 in one `eth_call`, batched in the same JSON-RPC request as `eth_chainId` and the
 * anchor transaction's receipt.
 */
export function createChainReader(opts: ChainReaderOptions = {}): ChainReader {
  return {
    async read(chainId, q) {
      const known = CHAINS[chainId];
      if (!known) throw new ChainUnreachableError(`no RPC is known for chain ${chainId}`);
      const chosen = opts.rpc?.[chainId];
      const custom = Boolean(chosen);
      const urls = chosen ? [chosen].flat() : known.rpcs;
      let answered = urls[0] as string;
      const transports = urls.map((url) =>
        http(url, {
          batch: { wait: 16 },
          retryCount: 0,
          timeout: opts.timeoutMs ?? 10_000,
          ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
          onFetchResponse: () => {
            answered = url;
          },
        }),
      );
      const client = createPublicClient({
        chain: known.chain,
        batch: { multicall: true },
        transport: transports.length === 1 ? (transports[0] as never) : fallback(transports),
      });
      const anchor = { address: q.anchor, abi: checkpointAnchorAbi } as const;
      const verifier = { address: q.verifier, abi: verdictVerifierAbi } as const;
      try {
        const settled = await Promise.allSettled([
          client.getChainId(),
          client.getBlockNumber({ cacheTime: 0 }),
          q.size > 0n
            ? client.readContract({ ...anchor, functionName: "rootAt", args: [q.origin, q.size] })
            : Promise.resolve(`0x${"0".repeat(64)}` as Hex),
          client.readContract({ ...anchor, functionName: "latest", args: [q.origin] }),
          Promise.all(
            q.signers.map((s) =>
              client.readContract({ ...verifier, functionName: "signers", args: [s] }),
            ),
          ),
          Promise.all(
            q.measurements.map((m) =>
              client.readContract({ ...verifier, functionName: "allowedMeasurement", args: [m] }),
            ),
          ),
          Promise.all(q.blocks.map((n) => client.getBlock({ blockNumber: n }).then((b) => b.hash))),
          q.c1
            ? client
                .readContract({
                  address: q.c1.verifier,
                  abi: honkVerifierAbi,
                  functionName: "verify",
                  args: [q.c1.proof, q.c1.publicInputs],
                })
                .catch((err: unknown) => {
                  // The verifier reverts on a proof it rejects; anything else is the RPC's failure.
                  if (
                    (err as BaseError).walk?.((e) => e instanceof ContractFunctionRevertedError)
                  ) {
                    return false;
                  }
                  throw err;
                })
            : Promise.resolve(undefined),
          q.anchorTx
            ? client.getTransactionReceipt({ hash: q.anchorTx }).catch((err: unknown) => {
                if ((err as Error).name === "TransactionReceiptNotFoundError") return null;
                throw err;
              })
            : Promise.resolve(undefined),
        ] as const);
        // The chain id first: another chain's RPC fails the reads for a reason it would not name.
        const [chainIdOf] = settled;
        if (chainIdOf.status === "fulfilled" && chainIdOf.value !== chainId) {
          throw new ChainUnreachableError(`the RPC answered for chain ${chainIdOf.value}`);
        }
        const failed = settled.find((s) => s.status === "rejected");
        if (failed) throw failed.reason;
        const [, head, rootAt, latest, signers, allowed, blocks, c1, receipt] = settled.map(
          (s) => (s as PromiseFulfilledResult<unknown>).value,
        ) as [
          number,
          bigint,
          Hex,
          readonly [bigint, Hex, number],
          (readonly [number, number, number, number, Hex])[],
          boolean[],
          Hex[],
          boolean | undefined,
          Awaited<ReturnType<typeof client.getTransactionReceipt>> | null | undefined,
        ];
        const out: ChainAnswer = {
          rootAt,
          latest: { size: latest[0], root: latest[1], at: latest[2] },
          signers: signers.map(([teeKind, registeredAt, expiresAt, revokedAt, measurement]) => ({
            teeKind,
            registeredAt,
            expiresAt,
            revokedAt,
            measurement,
          })),
          allowed,
          blocks,
          ...(c1 === undefined ? {} : { c1 }),
          rpc: answered,
          custom,
        };
        if (q.anchorBlock !== undefined && head < q.anchorBlock) {
          throw new ChainUnreachableError(`the RPC is at block ${head}, behind the anchor's`);
        }
        // The RPC is past the anchor's block, so a transaction it does not know is not on chain.
        if (receipt === null) out.anchorLog = null;
        if (receipt) {
          const log = parseEventLogs({
            abi: checkpointAnchorAbi,
            eventName: "CheckpointAnchored",
            logs: receipt.logs.filter((l) => l.address.toLowerCase() === q.anchor.toLowerCase()),
          }).find((l) => l.args.origin === q.origin && l.args.size === q.size);
          out.anchorLog =
            log && receipt.status === "success"
              ? {
                  origin: log.args.origin,
                  size: log.args.size,
                  root: log.args.root,
                  blockNumber: receipt.blockNumber,
                }
              : null;
        }
        return out;
      } catch (err) {
        if (err instanceof ChainUnreachableError) throw err;
        throw new ChainUnreachableError(
          `the chain could not be read: ${(err as { shortMessage?: string }).shortMessage ?? (err as Error).message}`,
        );
      }
    },
  };
}
