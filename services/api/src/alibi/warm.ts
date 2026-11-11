// Loads reflect-metadata before @keelson/alibi/verify pulls in @keelson/attest (see tee/attest.ts).
import "../tee/attest.ts";
import { verifyAlibi } from "@keelson/alibi/verify";
import { alibis, type Db, desc } from "@keelson/db";

/** The newest Alibi issued, if any. */
export async function newestAlibi(db: Db): Promise<unknown> {
  const [row] = await db
    .select({ bundle: alibis.bundle })
    .from(alibis)
    .orderBy(desc(alibis.createdAt))
    .limit(1);
  return row?.bundle;
}

/**
 * Verifies one issued Alibi, so the verifier's WebAssembly (bb.js, Cedar) is loaded and compiled
 * before a purchase's issuance verifies its own: the first verification in a process takes about
 * 3 s longer. Resolves to how long it took, or `undefined` when there is no Alibi to verify.
 */
export async function warmAlibiVerifier(
  bundle: () => Promise<unknown>,
): Promise<number | undefined> {
  const b = await bundle();
  if (b === undefined) return undefined;
  const started = performance.now();
  await verifyAlibi(b as Parameters<typeof verifyAlibi>[0]);
  return Math.round(performance.now() - started);
}
