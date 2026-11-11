import { amberContradictionCourtAbi } from "@keelson/chain";
import {
  amberConvictions,
  and,
  chainEvents,
  type Db,
  eq,
  isNull,
  type StoredC2b,
  sql,
} from "@keelson/db";
import type { Logger } from "pino";
import {
  BaseError,
  bytesToHex,
  decodeFunctionData,
  encodeAbiParameters,
  type Hex,
  hexToBytes,
  keccak256,
  type PublicClient,
} from "viem";

export const AMBER_CHAIN_ID = 421614;
const BN254_FR_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The ULID a coverage id right-aligns, or `null` for another id. */
export function purchaseOfCoverage(coverageId: Hex): string | null {
  const n = BigInt(coverageId);
  if (n >> 128n !== 0n) return null;
  let out = "";
  for (let i = 0; i < 26; i++) out = (ULID[Number((n >> BigInt(5 * i)) & 31n)] as string) + out;
  return out;
}

/** The C2b proof and `WebFact` of a `slashAmber` call, or `null` when the call went through another contract. */
export function c2bOfCall(input: Hex): StoredC2b | null {
  let call: ReturnType<typeof decodeFunctionData<typeof amberContradictionCourtAbi>>;
  try {
    call = decodeFunctionData({ abi: amberContradictionCourtAbi, data: input });
  } catch {
    return null;
  }
  if (call.functionName !== "slashAmber") return null;
  const [c, , , fact, , fieldId, proof] = call.args;
  const range = BigInt(fact.rangeCommitment);
  const page = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [fact.hostHash, fact.urlPathHash],
    ),
  );
  const word = (x: bigint) => `0x${x.toString(16).padStart(64, "0")}`;
  return {
    bytes: hexToBytes(proof).length,
    hash: keccak256(proof),
    public_inputs: [
      word(range >> 128n),
      word(range & ((1n << 128n) - 1n)),
      c.amberCommitment,
      word(BigInt(page) % BN254_FR_MODULUS),
      word(BigInt(fieldId)),
    ],
    fact: {
      host_hash: fact.hostHash,
      url_path_hash: fact.urlPathHash,
      range_commitment: fact.rangeCommitment,
      t_capture: fact.tCapture.toString(),
    },
  };
}

/** Convictions projected per pass; the rest wait for the next one. */
const BATCH = 100;

const brief = (err: unknown) =>
  err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);

/**
 * Projects the court's `AmberContradictionProven` events the chain-events follower stored and
 * nothing handled yet into `amber_convictions`, with the proof read from the `slashAmber` call
 * and the time from the event's block: two reads per conviction, none when there is none. An
 * event is handled once projected; one that fails stays unhandled for the next pass.
 */
export async function projectAmberConvictions(deps: {
  db: Db;
  log: Logger;
  client: PublicClient;
}): Promise<number> {
  const { db, client } = deps;
  const rows = await db
    .select({
      txHash: chainEvents.txHash,
      logIndex: chainEvents.logIndex,
      blockNumber: chainEvents.blockNumber,
      address: chainEvents.address,
      args: chainEvents.args,
    })
    .from(chainEvents)
    .where(
      and(
        eq(chainEvents.chainId, AMBER_CHAIN_ID),
        eq(chainEvents.name, "AmberContradictionProven"),
        isNull(chainEvents.handledAt),
      ),
    )
    .orderBy(chainEvents.blockNumber)
    .limit(BATCH);
  let projected = 0;
  for (const row of rows) {
    const args = row.args as { coverageId: Hex; fieldId: string | number; webFactDigest: Hex };
    const court = bytesToHex(row.address);
    try {
      const [tx, block] = await Promise.all([
        client.getTransaction({ hash: bytesToHex(row.txHash) }),
        client.getBlock({ blockNumber: row.blockNumber }),
      ]);
      await db.transaction(async (t) => {
        await t
          .insert(amberConvictions)
          .values({
            coverageId: Buffer.from(hexToBytes(args.coverageId)),
            purchaseId: purchaseOfCoverage(args.coverageId),
            chainId: AMBER_CHAIN_ID,
            fieldId: Number(args.fieldId),
            provenAt: new Date(Number(block.timestamp) * 1000),
            webFactDigest: Buffer.from(hexToBytes(args.webFactDigest)),
            txHash: row.txHash,
            blockNumber: row.blockNumber,
            proof: tx.to?.toLowerCase() === court.toLowerCase() ? c2bOfCall(tx.input) : null,
          })
          .onConflictDoNothing();
        await t
          .update(chainEvents)
          .set({ handledAt: sql`now()` })
          .where(
            and(
              eq(chainEvents.chainId, AMBER_CHAIN_ID),
              eq(chainEvents.txHash, row.txHash),
              eq(chainEvents.logIndex, row.logIndex),
            ),
          );
      });
      projected++;
    } catch (err) {
      deps.log.warn(
        { coverageId: args.coverageId, err: brief(err) },
        "amber conviction not projected",
      );
    }
  }
  if (projected > 0) deps.log.info({ projected }, "amber convictions projected");
  return projected;
}
