import {
  checkpointAnchorAbi,
  deploymentsFor,
  honkVerifierAbi,
  registeredUserSetAbi,
  verdictVerifierAbi,
} from "@keelson/chain";
import {
  type Address,
  type BaseError,
  bytesToHex,
  type Chain,
  ContractFunctionRevertedError,
  createPublicClient,
  fallback,
  type Hex,
  http,
  parseAbi,
  parseEventLogs,
  type TransactionReceipt,
} from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import { fromBase64 } from "../b64.ts";
import { ENGINE_PROGRAM_VKEY } from "./engine-vk.ts";

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
  /** A C3 proof's registered-user root, and the transaction stated to have published it. */
  c3?: { registry: Address; root: Hex; tx: Hex };
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
  /**
   * `RegisteredUserSet.roots(root)` of `ChainQuery.c3`, `publishedAt` 0 when unpublished, and the
   * `RootPublished` log of its transaction, `null` when it holds none or does not exist.
   */
  c3?: {
    publishedAt: number;
    size: number;
    /** When the Guardian revoked the root; 0 while it stands. */
    revokedAt: number;
    log: { size: number; blockNumber: bigint } | null;
  };
  /** The RPC that answered. */
  rpc: string;
  /** Whether that RPC was chosen by the caller rather than one of the public defaults. */
  custom: boolean;
}

type Receipt = TransactionReceipt;

/** The registry's record of a root, and the `RootPublished` its transaction emitted for it. */
function c3Of(
  q: NonNullable<ChainQuery["c3"]>,
  [publishedAt, size, revokedAt]: readonly [bigint, number, bigint],
  receipt: Receipt | null,
): NonNullable<ChainAnswer["c3"]> {
  const log = receipt
    ? parseEventLogs({
        abi: registeredUserSetAbi,
        eventName: "RootPublished",
        logs: receipt.logs.filter((l) => l.address.toLowerCase() === q.registry.toLowerCase()),
      }).find((l) => l.args.root.toLowerCase() === q.root.toLowerCase())
    : undefined;
  return {
    publishedAt: Number(publishedAt),
    size,
    revokedAt: Number(revokedAt),
    log:
      log && receipt?.status === "success"
        ? { size: log.args.size, blockNumber: receipt.blockNumber }
        : null,
  };
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

/** A client of chain `chainId` over its RPCs in order, and which of them answered last. */
function clientOf(chainId: number, opts: ChainReaderOptions) {
  const known = CHAINS[chainId];
  if (!known) throw new ChainUnreachableError(`no RPC is known for chain ${chainId}`);
  const chosen = opts.rpc?.[chainId];
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
  return { client, answered: () => answered, custom: Boolean(chosen) };
}

const receiptOf = (client: ReturnType<typeof clientOf>["client"], hash: Hex) =>
  client.getTransactionReceipt({ hash }).catch((err: unknown) => {
    if ((err as Error).name === "TransactionReceiptNotFoundError") return null;
    throw err;
  });

/** Whether a Honk verifier accepts a proof; it reverts on one it rejects. */
const honkVerify = (
  client: ReturnType<typeof clientOf>["client"],
  verifier: Address,
  proof: Hex,
  publicInputs: Hex[],
) =>
  client
    .readContract({
      address: verifier,
      abi: honkVerifierAbi,
      functionName: "verify",
      args: [proof, publicInputs],
    })
    .catch((err: unknown) => {
      // Anything but a revert is the RPC's failure.
      if ((err as BaseError).walk?.((e) => e instanceof ContractFunctionRevertedError)) {
        return false;
      }
      throw err;
    });

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
      const { client, answered, custom } = clientOf(chainId, opts);
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
            ? honkVerify(client, q.c1.verifier, q.c1.proof, q.c1.publicInputs)
            : Promise.resolve(undefined),
          q.anchorTx ? receiptOf(client, q.anchorTx) : Promise.resolve(undefined),
          q.c3
            ? Promise.all([
                client.readContract({
                  address: q.c3.registry,
                  abi: registeredUserSetAbi,
                  functionName: "roots",
                  args: [q.c3.root],
                }),
                receiptOf(client, q.c3.tx),
              ])
            : Promise.resolve(undefined),
        ] as const);
        // The chain id first: another chain's RPC fails the reads for a reason it would not name.
        const [chainIdOf] = settled;
        if (chainIdOf.status === "fulfilled" && chainIdOf.value !== chainId) {
          throw new ChainUnreachableError(`the RPC answered for chain ${chainIdOf.value}`);
        }
        const failed = settled.find((s) => s.status === "rejected");
        if (failed) throw failed.reason;
        const [, head, rootAt, latest, signers, allowed, blocks, c1, receipt, c3] = settled.map(
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
          Receipt | null | undefined,
          readonly [readonly [bigint, number, bigint], Receipt | null] | undefined,
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
          ...(c3 && q.c3 ? { c3: c3Of(q.c3, c3[0], c3[1]) } : {}),
          rpc: answered(),
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

const engineProofVerifierAbi = parseAbi([
  "function verify(bytes publicValues, bytes proof) view returns (bytes32 evalHash, bytes32 countersignDigest)",
  "function PROGRAM_VKEY() view returns (bytes32)",
]);

/** What `EngineProofVerifier.verify` answered for an SP1 proof of a countersign's evaluation. */
export interface EngineProofAnswer {
  /** The `evalHash` and countersign digest the proof commits to; null when the proof is rejected. */
  proven: { evalHash: Hex; countersignDigest: Hex } | null;
  /** The deployed verifier, pinned per chain, that answered. */
  verifier: Address;
  rpc: string;
}

/**
 * Checks an SP1 proof of the engine evaluation with the pinned `EngineProofVerifier` of `chainId`
 * in an `eth_call`, which verifies it through Succinct's SP1 verifier gateway, after checking that
 * the verifier holds the pinned engine program key.
 */
export async function verifyEngineProof(
  chainId: number,
  publicValues: Hex,
  proof: Hex,
  opts: ChainReaderOptions = {},
): Promise<EngineProofAnswer> {
  const known = CHAINS[chainId];
  const verifier = known ? deploymentsFor(chainId).EngineProofVerifier : undefined;
  if (!known || !verifier) {
    throw new ChainUnreachableError(`no engine proof verifier is known for chain ${chainId}`);
  }
  const chosen = opts.rpc?.[chainId];
  const urls = chosen ? [chosen].flat() : known.rpcs;
  const client = createPublicClient({
    chain: known.chain,
    transport: fallback(
      urls.map((url) =>
        http(url, {
          retryCount: 0,
          timeout: opts.timeoutMs ?? 10_000,
          ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
        }),
      ),
    ),
  });
  const contract = { address: verifier, abi: engineProofVerifierAbi } as const;
  const rpc = urls[0] as string;
  try {
    const vkey = await client.readContract({ ...contract, functionName: "PROGRAM_VKEY" });
    if (vkey.toLowerCase() !== ENGINE_PROGRAM_VKEY) return { proven: null, verifier, rpc };
    const [evalHash, countersignDigest] = await client.readContract({
      ...contract,
      functionName: "verify",
      args: [publicValues, proof],
    });
    return { proven: { evalHash, countersignDigest }, verifier, rpc };
  } catch (err) {
    if ((err as BaseError).walk?.((e) => e instanceof ContractFunctionRevertedError)) {
      return { proven: null, verifier, rpc };
    }
    throw new ChainUnreachableError((err as Error).message);
  }
}

/** What the chain says of a composed proof: whether the verifier accepts it, and its root. */
export interface AnonymousPurchaseAnswer {
  accepted: boolean;
  /** `RegisteredUserSet.roots(root)`, and the `RootPublished` log of `root_tx` when one is given. */
  root: NonNullable<ChainAnswer["c3"]>;
  rpc: string;
  custom: boolean;
}

/**
 * Reads, in one HTTP request, whether the deployed `AnonymousPurchaseVerifier` accepts composed
 * proof `p` in an `eth_call`, and the record `RegisteredUserSet` holds of its root. As for
 * {@link createChainReader}, the RPC is trusted for what it reads.
 */
export async function readAnonymousPurchase(
  chainId: number,
  p: { proof: string; public_inputs: readonly string[]; user_set_root: string; root_tx?: string },
  opts: ChainReaderOptions = {},
): Promise<AnonymousPurchaseAnswer> {
  const { AnonymousPurchaseVerifier: verifier, RegisteredUserSet: registry } =
    deploymentsFor(chainId);
  if (!verifier || !registry) {
    throw new ChainUnreachableError(`no anonymous-purchase verifier is pinned on chain ${chainId}`);
  }
  const { client, answered, custom } = clientOf(chainId, opts);
  const root = p.user_set_root as Hex;
  try {
    const [id, accepted, record, receipt] = await Promise.all([
      client.getChainId(),
      honkVerify(client, verifier, bytesToHex(fromBase64(p.proof)), p.public_inputs as Hex[]),
      client.readContract({
        address: registry,
        abi: registeredUserSetAbi,
        functionName: "roots",
        args: [root],
      }),
      p.root_tx ? receiptOf(client, p.root_tx as Hex) : Promise.resolve(null),
    ]);
    if (id !== chainId) throw new ChainUnreachableError(`the RPC answered for chain ${id}`);
    return {
      accepted,
      root: c3Of({ registry, root, tx: (p.root_tx ?? "0x") as Hex }, record, receipt),
      rpc: answered(),
      custom,
    };
  } catch (err) {
    if (err instanceof ChainUnreachableError) throw err;
    throw new ChainUnreachableError(
      `the chain could not be read: ${(err as { shortMessage?: string }).shortMessage ?? (err as Error).message}`,
    );
  }
}
