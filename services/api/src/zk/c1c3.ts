// Loads reflect-metadata before @keelson/alibi/verify pulls in @keelson/attest (see tee/attest.ts).
import "../tee/attest.ts";
import { fromBase64, toBase64 } from "@keelson/alibi";
import { c1c3Statement, verifyC1C3 } from "@keelson/alibi/verify";
import { type Db, eq, mandates, purchases, sql } from "@keelson/db";
import type { Logger } from "pino";
import { prove, recursiveKey } from "./bb.ts";

/** A composed proof as the API stores and serves it: base64 proof bytes and 32-byte hex inputs. */
export interface C1C3Proof {
  proof: string;
  public_inputs: string[];
}

/** A proof's 32-byte fields as hex, as a Noir `[Field; N]` input takes them. */
function fields(base64: string): string[] {
  const bytes = fromBase64(base64);
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 32) {
    out.push(`0x${Buffer.from(bytes.subarray(i, i + 32)).toString("hex")}`);
  }
  return out;
}

/** Whether purchase `purchaseId` has the recursive C1 and C3 proofs a composition needs. */
export async function composable(db: Db, purchaseId: string): Promise<boolean> {
  const [row] = await db
    .select({ c1: purchases.c1Proof, c3: mandates.c3Proof, c1c3: purchases.c1c3Proof })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .where(eq(purchases.id, purchaseId));
  return Boolean(row && !row.c1c3 && row.c1?.recursive_proof && row.c3?.recursive_proof);
}

/**
 * Composes purchase `purchaseId`'s C1 proof with its mandate's C3 proof into one
 * `anonymous_purchase` proof, stores it on the purchase and returns it. A purchase that already
 * has one keeps it.
 *
 * @throws {RangeError} when either proof, or its recursive form, is missing: nothing to compose.
 */
export async function proveAnonymousPurchase(
  deps: { db: Db; log: Logger },
  purchaseId: string,
): Promise<C1C3Proof> {
  const { db, log } = deps;
  const [row] = await db
    .select({
      c1: purchases.c1Proof,
      c1c3: purchases.c1c3Proof,
      countersign: purchases.countersign,
      c3: mandates.c3Proof,
    })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .where(eq(purchases.id, purchaseId));
  if (row?.c1c3) return row.c1c3;
  const { c1, c3 } = row ?? {};
  if (!row?.countersign || !c1?.recursive_proof || !c3?.recursive_proof) {
    throw new RangeError(`purchase ${purchaseId} has no recursive C1 and C3 proofs to compose`);
  }
  if (c1.public_inputs[0] !== c3.public_inputs[0]) {
    throw new RangeError(`purchase ${purchaseId}'s C1 and C3 proofs are of other mandates`);
  }
  const started = performance.now();
  const c1Key = recursiveKey("mandate_predicate");
  const c3Key = recursiveKey("anonymous_mandate");
  const { evm } = await prove(
    "anonymous_purchase",
    {
      c1_inputs: c1.public_inputs,
      mandate_hash: c3.public_inputs[1],
      user_set_root: c3.public_inputs[2],
      c1_vk: c1Key.vk,
      c1_proof: fields(c1.recursive_proof),
      c3_vk: c3Key.vk,
      c3_proof: fields(c3.recursive_proof),
    },
    ["evm"],
  );
  const c1c3: C1C3Proof = { proof: toBase64(evm.proof), public_inputs: evm.publicInputs };
  const countersign = Object.fromEntries(
    Object.entries(row.countersign).map(([k, v]) => [k, v.toLowerCase()]),
  ) as Parameters<typeof c1c3Statement>[0];
  const expected = c1c3Statement(countersign, c3.public_inputs[2] as string);
  const holds = expected.every((x, i) => x === c1c3.public_inputs[i]);
  if (!holds || !(await verifyC1C3(c1c3.proof, c1c3.public_inputs))) {
    throw new Error(`the composed proof of purchase ${purchaseId} does not verify`);
  }
  await db
    .update(purchases)
    .set({ c1c3Proof: c1c3 })
    .where(sql`${purchases.id} = ${purchaseId} and ${purchases.c1c3Proof} is null`);
  log.info({ purchaseId, ms: Math.round(performance.now() - started) }, "C1 and C3 composed");
  return c1c3;
}
