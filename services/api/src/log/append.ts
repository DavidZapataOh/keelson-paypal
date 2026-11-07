import { CHAIN_IDS } from "@keelson/core/eip712";
import { and, type Db, eq, isNull, or, purchases } from "@keelson/db";
import {
  type AppendResult,
  LEAF_PREFIX,
  LOG_ORIGINS,
  LOG_VKEYS,
  LogClient,
  LogError,
  leafHash,
  verifyProof,
} from "@keelson/log";

/** Where the Alibi log's private write listener is and the token it takes. */
export interface LogConfig {
  url: string;
  token: string;
  timeoutMs?: number;
  /** The verifier keys of each origin; the published ones by default. */
  vkeys?: Readonly<Record<string, readonly string[]>>;
}

const decoder = new TextDecoder();

/** The `alibi_id` and `mode` the leaf states; the log checks the rest. */
function stated(leaf: Uint8Array): { alibiId: string; mode: string } {
  const text = decoder.decode(leaf);
  if (!text.startsWith(LEAF_PREFIX)) throw new LogError("rejected", "leaf.prefix");
  try {
    const body = JSON.parse(text.slice(LEAF_PREFIX.length)) as {
      alibi_id?: unknown;
      mode?: unknown;
    };
    return { alibiId: String(body.alibi_id), mode: String(body.mode) };
  } catch {
    throw new LogError("rejected", "leaf.noncanonical");
  }
}

/**
 * Appends the purchase's leaf to the log of its chain and records the index it got. A leaf for
 * another purchase, or whose mode is not the one the purchase was countersigned in, is refused
 * before the log is called. The index is recorded only once the log's leaf hash is the leaf's and
 * its proof verifies against a checkpoint both origin keys signed. Appending the same leaf again
 * returns the same index.
 *
 * @internal
 */
export async function appendLeaf(
  deps: { db: Db; tlog: LogConfig },
  purchaseId: string,
  leaf: Uint8Array,
  countersign: Record<string, string>,
): Promise<AppendResult> {
  const [purchase] = await deps.db
    .select({ mode: purchases.countersignMode, chainId: purchases.chainId })
    .from(purchases)
    .where(eq(purchases.id, purchaseId));
  if (!purchase) throw new LogError("rejected", "purchase.unknown");
  const leafStates = stated(leaf);
  if (leafStates.alibiId !== purchaseId) throw new LogError("rejected", "countersign.fields");
  if (purchase.mode === null || leafStates.mode !== purchase.mode) {
    throw new LogError("rejected", "countersign.mode");
  }
  const origin = LOG_ORIGINS[purchase.chainId ?? CHAIN_IDS.arbitrumSepolia];
  if (!origin) throw new LogError("rejected", "purchase.chain");

  const client = new LogClient(deps.tlog.url, deps.tlog.token, origin, deps.tlog.timeoutMs);
  const result = await client.add(leaf, countersign);
  const expected = leafHash(leaf);
  if (result.leafHash.length !== 32 || !result.leafHash.every((b, i) => b === expected[i])) {
    throw new LogError("invalid", "leaf_hash");
  }
  const vkeys = deps.tlog.vkeys?.[origin] ?? LOG_VKEYS[origin];
  let verified = false;
  try {
    verified =
      vkeys !== undefined && verifyProof(result.proof, expected, vkeys).index === result.index;
  } catch {
    verified = false;
  }
  if (!verified) throw new LogError("invalid", "proof");
  const updated = await deps.db
    .update(purchases)
    .set({ logIndex: result.index })
    .where(
      and(
        eq(purchases.id, purchaseId),
        or(isNull(purchases.logIndex), eq(purchases.logIndex, result.index)),
      ),
    )
    .returning({ id: purchases.id });
  if (updated.length === 0) throw new LogError("rejected", "purchase.logged");
  return result;
}
