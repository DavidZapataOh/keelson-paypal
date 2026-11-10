import { amberContradictionCourtAbi, deploymentsFor } from "@keelson/chain";
import { amberConvictions, type Db, type StoredC2b } from "@keelson/db";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import {
  type Address,
  decodeFunctionData,
  encodeAbiParameters,
  type Hex,
  hexToBytes,
  keccak256,
  type PublicClient,
} from "viem";

export const AMBER_CHAIN_ID = 421614;
/** The block `AmberContradictionCourt` was deployed at, where the search for its events starts. */
export const AMBER_COURT_DEPLOYED_AT = 0n;
/** The block range of one `eth_getLogs` call. */
const LOG_RANGE = 100_000n;
/** About 5 s of Arbitrum blocks, so a block the RPC has not indexed yet is scanned on a later pass. */
const CONFIRMATIONS = 20n;
/** Reads of dispute data within this long of a scan reuse it. */
const SCAN_EVERY_MS = 30_000;
const BN254_FR_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface AmberCourtDeps {
  db: Db;
  kv: RedisClientType;
  log: Logger;
  /** `client` reads the court and transactions; `logs` serves `eth_getLogs` over wide ranges. */
  chain: { client: PublicClient; logs?: PublicClient };
}

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

const cursorKey = (court: Address) => `amber:court:${AMBER_CHAIN_ID}:${court.toLowerCase()}`;

/** Projects the court's new `AmberContradictionProven` events into `amber_convictions`. */
async function scan(deps: AmberCourtDeps, court: Address): Promise<number> {
  const { client } = deps.chain;
  const logClient = deps.chain.logs ?? client;
  const cursor = await deps.kv.get(cursorKey(court));
  const fromBlock = cursor ? BigInt(cursor) + 1n : AMBER_COURT_DEPLOYED_AT;
  // Head and logs from the same RPC, kept CONFIRMATIONS behind its head: a block that RPC has not
  // indexed yet is never passed by the cursor.
  const latest = (await logClient.getBlockNumber()) - CONFIRMATIONS;
  let found = 0;
  for (let from = fromBlock; from <= latest; from += LOG_RANGE) {
    // biome-ignore lint/complexity/useMathMinMax: block numbers are bigints.
    const to = from + LOG_RANGE - 1n < latest ? from + LOG_RANGE - 1n : latest;
    const events = await logClient.getContractEvents({
      address: court,
      abi: amberContradictionCourtAbi,
      eventName: "AmberContradictionProven",
      fromBlock: from,
      toBlock: to,
    });
    for (const e of events) {
      const coverageId = e.args.coverageId as Hex;
      const [tx, [fieldId, provenAt, digest]] = await Promise.all([
        client.getTransaction({ hash: e.transactionHash }),
        client.readContract({
          address: court,
          abi: amberContradictionCourtAbi,
          functionName: "violations",
          args: [coverageId],
          blockNumber: e.blockNumber,
        }),
      ]);
      await deps.db
        .insert(amberConvictions)
        .values({
          coverageId: Buffer.from(hexToBytes(coverageId)),
          purchaseId: purchaseOfCoverage(coverageId),
          chainId: AMBER_CHAIN_ID,
          fieldId,
          provenAt: new Date(provenAt * 1000),
          webFactDigest: Buffer.from(hexToBytes(digest)),
          txHash: Buffer.from(hexToBytes(e.transactionHash)),
          blockNumber: e.blockNumber,
          proof: tx.to?.toLowerCase() === court.toLowerCase() ? c2bOfCall(tx.input) : null,
        })
        .onConflictDoNothing();
      found++;
    }
    await deps.kv.set(cursorKey(court), String(to));
  }
  return found;
}

let last: { at: number; run: Promise<void> } | undefined;

/**
 * Brings `amber_convictions` up to the chain, at most once per {@link SCAN_EVERY_MS} however many
 * reads ask: one `eth_getBlockNumber` and one `eth_getLogs` per new range, and two reads per new
 * conviction. Resolves without scanning where the court is not deployed; a failed scan is logged
 * and the projection read as it stands.
 */
export function syncAmberConvictions(deps: AmberCourtDeps): Promise<void> {
  const court = deploymentsFor(AMBER_CHAIN_ID).AmberContradictionCourt;
  if (!court) return Promise.resolve();
  if (last && Date.now() - last.at < SCAN_EVERY_MS) return last.run;
  const run = scan(deps, court).then(
    (found) => {
      if (found > 0) deps.log.info({ found }, "amber convictions projected");
    },
    (err: unknown) => {
      // The next read scans again from the cursor.
      last = undefined;
      deps.log.warn({ err }, "amber court scan failed");
    },
  );
  last = { at: Date.now(), run };
  return run;
}
