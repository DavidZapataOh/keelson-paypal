import { type Db, relayerNonces, sql } from "@keelson/db";
import { type Address, hexToBytes } from "viem";

const addr = (a: Address) => Buffer.from(hexToBytes(a));

/**
 * Takes the next nonce of `sender` on `chainId` in one atomic statement, so any number of processes can share the
 * address. `seed` gives the chain's pending count the first time the address is seen.
 */
export async function allocateNonce(
  db: Db,
  chainId: number,
  sender: Address,
  seed: () => Promise<bigint>,
): Promise<bigint> {
  const bump = () =>
    db.execute<{ nonce: string }>(sql`
      update relayer_nonces set next = next + 1
      where chain_id = ${chainId} and address = ${addr(sender)}
      returning next - 1 as nonce`);
  let { rows } = await bump();
  if (rows[0]) return BigInt(rows[0].nonce);
  await db
    .insert(relayerNonces)
    .values({ chainId, address: addr(sender), next: await seed() })
    .onConflictDoNothing();
  ({ rows } = await bump());
  if (!rows[0]) throw new Error("the nonce row vanished");
  return BigInt(rows[0].nonce);
}

/** Moves the allocator back to the chain's count after a gap: the nonces above it were never used. */
export async function resyncNonce(
  db: Db,
  chainId: number,
  sender: Address,
  chainCount: bigint,
): Promise<void> {
  await db.execute(sql`
    update relayer_nonces set next = ${chainCount}
    where chain_id = ${chainId} and address = ${addr(sender)} and next > ${chainCount}`);
}

/** Moves the allocator up to the chain's count when the address was used outside it. */
export async function advanceNonce(
  db: Db,
  chainId: number,
  sender: Address,
  chainCount: bigint,
): Promise<void> {
  await db.execute(sql`
    update relayer_nonces set next = ${chainCount}
    where chain_id = ${chainId} and address = ${addr(sender)} and next < ${chainCount}`);
}

export async function nextNonce(
  db: Db,
  chainId: number,
  sender: Address,
): Promise<bigint | undefined> {
  const { rows } = await db.execute<{ next: string }>(sql`
    select next from relayer_nonces where chain_id = ${chainId} and address = ${addr(sender)}`);
  return rows[0] ? BigInt(rows[0].next) : undefined;
}
