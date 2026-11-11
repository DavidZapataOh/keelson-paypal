import { amberContradictionCourtAbi, deploymentsFor, keelsonBondVaultAbi } from "@keelson/chain";
import { ulidToBytes, ulidToBytes32 } from "@keelson/core";
import {
  type Address,
  createPublicClient,
  decodeFunctionData,
  type Hex,
  http,
  type PublicClient,
} from "viem";
import { arbitrumSepolia } from "viem/chains";
import { c2bStatement, verifyC2b } from "./zk.ts";

const CHAIN_ID = arbitrumSepolia.id;
/** A block before Keelson's contracts were deployed on Arbitrum Sepolia: no search starts earlier. */
const DEPLOYED_AFTER = 327_140_590n;
/** Blocks searched after the purchase for its coverage: about seven hours of Arbitrum Sepolia. */
const LOCK_WINDOW = 100_000n;
/** Blocks searched from the first with the conviction's timestamp. */
const CONVICTION_WINDOW = 1_000n;

/** What Arbitrum Sepolia holds of an Alibi's amber attestation, and the proof it was convicted with. */
export interface AmberReading {
  /** Whether `AmberContradictionCourt` is deployed; nothing else is read without it. */
  court: boolean;
  /** The `amberCommitment` the coverage was locked with; zero for none, `null` when no lock was found. */
  commitment: Hex | null;
  conviction: {
    fieldId: number;
    provenAt: Date;
    webFactDigest: Hex;
    txHash: Hex;
    /** The proof's size in bytes, `null` when the call went through another contract. */
    proofBytes: number | null;
    /** The proof verified in this process against the pinned C2b key, on the statement below. */
    proofVerified: boolean;
    /** The statement opens the coverage's own commitment and names the convicted field. */
    statementMatches: boolean;
  } | null;
}

/** When a ULID was minted, in seconds: its first 48 bits are milliseconds since the epoch. */
function mintedAt(id: string): bigint {
  let ms = 0n;
  for (const b of ulidToBytes(id).subarray(0, 6)) ms = (ms << 8n) | BigInt(b);
  return ms / 1000n;
}

/** The first block at or after `t` (seconds), by binary search over block timestamps. */
async function blockAt(client: PublicClient, t: bigint, latest: bigint): Promise<bigint> {
  let lo = DEPLOYED_AFTER;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const { timestamp } = await client.getBlock({ blockNumber: mid });
    if (timestamp < t) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Reads, for the Alibi `alibiId`, the amber commitment its coverage
 * was locked with and `AmberContradictionCourt`'s conviction of it, and verifies the conviction's
 * C2b proof here rather than trusting the court's verifier. The RPC is trusted for what it reads;
 * `rpc` replaces the chain's public one.
 */
export async function readAmber(
  alibiId: string,
  opts: { rpc?: string; client?: PublicClient } = {},
): Promise<AmberReading> {
  const d = deploymentsFor(CHAIN_ID);
  const court = d.AmberContradictionCourt as Address | undefined;
  const vault = d.KeelsonBondVault as Address;
  if (!court) return { commitment: null, conviction: null, court: false };
  const client =
    opts.client ??
    (createPublicClient({ chain: arbitrumSepolia, transport: http(opts.rpc) }) as PublicClient);
  const coverageId = ulidToBytes32(alibiId);
  const latest = await client.getBlockNumber();

  // The purchase id is minted when the agent asks for the countersign, before the coverage.
  const lockedFrom = await blockAt(client, mintedAt(alibiId) - 60n, latest);
  const [locked] = await client.getContractEvents({
    address: vault,
    abi: keelsonBondVaultAbi,
    eventName: "CoverageLocked",
    args: { coverageId },
    fromBlock: lockedFrom,
    toBlock: min(latest, lockedFrom + LOCK_WINDOW),
  });
  const commitment = (locked?.args.amberCommitment as Hex | undefined) ?? null;

  const [fieldId, provenAt, webFactDigest] = await client.readContract({
    address: court,
    abi: amberContradictionCourtAbi,
    functionName: "violations",
    args: [coverageId],
  });
  if (fieldId === 0) return { court: true, commitment, conviction: null };

  const provenFrom = await blockAt(client, BigInt(provenAt), latest);
  const [proven] = await client.getContractEvents({
    address: court,
    abi: amberContradictionCourtAbi,
    eventName: "AmberContradictionProven",
    args: { coverageId },
    fromBlock: provenFrom,
    toBlock: min(latest, provenFrom + CONVICTION_WINDOW),
  });
  if (!proven) throw new Error("the conviction's event was not found near its time");
  const tx = await client.getTransaction({ hash: proven.transactionHash });
  const conviction = {
    fieldId,
    provenAt: new Date(provenAt * 1000),
    webFactDigest,
    txHash: proven.transactionHash,
    proofBytes: null as number | null,
    proofVerified: false,
    statementMatches: false,
  };
  if (tx.to?.toLowerCase() !== court.toLowerCase()) return { court: true, commitment, conviction };
  const call = decodeFunctionData({ abi: amberContradictionCourtAbi, data: tx.input });
  if (call.functionName !== "slashAmber") return { court: true, commitment, conviction };
  const [c, , , fact, , calledField, proof] = call.args;
  const statement = c2bStatement(fact, c.amberCommitment, calledField);
  return {
    court: true,
    commitment,
    conviction: {
      ...conviction,
      proofBytes: (proof.length - 2) / 2,
      proofVerified: await verifyC2b(proof, statement),
      statementMatches:
        calledField === fieldId &&
        commitment !== null &&
        BigInt(c.amberCommitment) === BigInt(commitment) &&
        c.coverageId.toLowerCase() === coverageId.toLowerCase(),
    },
  };
}
