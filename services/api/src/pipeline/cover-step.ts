import {
  addresses,
  type Coverage,
  coverageTypedData,
  keelsonBondVaultAbi,
  lockCoverageArgs,
  passkeyPublicKey,
  type SignedAssertion,
  userKeyHash,
} from "@keelson/chain";
import { type Db, eq, mandates, purchases, sql } from "@keelson/db";
import { decodeMandate, hSd } from "@keelson/mandate";
import { type Relayer, RelayerError, type TxRecord } from "@keelson/relayer";
import {
  BaseError,
  bytesToHex,
  type Hex,
  HttpRequestError,
  hexToBytes,
  type PublicClient,
} from "viem";
import { fixAmber } from "../amber.ts";
import { KEELSON_TREASURY, SETTLEMENT } from "../merchants.ts";
import type { OperatorSigners } from "../operators/signer.ts";
import { premiumBps } from "../risk.ts";
import { countersignMessage } from "../tee/coordinator.ts";
import { countersignOf } from "./leaf.ts";
import { done, final, type Outcome, retry } from "./outcome.ts";

const CHAIN_ID = 421614;
const VAULT = addresses[CHAIN_ID].KeelsonBondVault as Hex;
/** PYUSD base units per US cent. */
const PYUSD_PER_MINOR = 10_000n;
const PENDING_WAIT_MS = 8_000;
const PARAMS_TTL_MS = 60_000;
const ACTIVE = 1;
/** Refusals of the relayer's own state, not of the coverage: a later attempt may be sent. */
const RETRYABLE = new Set(["chain-unavailable", "gas-price-cap", "relayer-low-balance"]);
const ZERO = `0x${"00".repeat(32)}` as Hex;

export interface CoverStepDeps {
  db: Db;
  relayer?: Relayer | undefined;
  operators?: OperatorSigners | undefined;
  /** Reads the vault on Arbitrum Sepolia. */
  chain?: { client: PublicClient } | undefined;
}

let params: { disputeWindow: number; at: number } | undefined;

async function disputeWindow(client: PublicClient): Promise<number> {
  if (params && Date.now() - params.at < PARAMS_TTL_MS) return params.disputeWindow;
  const p = await client.readContract({
    address: VAULT,
    abi: keelsonBondVaultAbi,
    functionName: "params",
  });
  params = { disputeWindow: Number(p.disputeWindow), at: Date.now() };
  return params.disputeWindow;
}

/** The premium paid to the reserve: `bps` of the covered amount, rounded up. */
const premiumOf = (amount: bigint, bps: number) => (amount * BigInt(bps) + 9_999n) / 10_000n;

/**
 * The premium of the purchase's coverage, in basis points: the operator's trust grade prices it
 * on the first attempt, which fixes it on the purchase so that every retry signs the same coverage.
 */
async function premiumFor(db: Db, purchaseId: string, agentId: bigint, fixed: number | null) {
  if (fixed !== null) return fixed;
  const bps = await premiumBps(db, agentId);
  const [row] = await db
    .update(purchases)
    .set({ premiumBps: sql`coalesce(${purchases.premiumBps}, ${bps})` })
    .where(eq(purchases.id, purchaseId))
    .returning({ premiumBps: purchases.premiumBps });
  return row?.premiumBps ?? bps;
}

/** The `lockCoverage` relayer key of a purchase. */
const coverageKey = (coverageId: Hex) => `KeelsonBondVault.lockCoverage:${coverageId}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const unreachable = (err: unknown) =>
  err instanceof BaseError && err.walk((e) => e instanceof HttpRequestError) !== null;

/**
 * Locks the operator's bond behind the purchase on Arbitrum Sepolia: the operator signs the
 * `Coverage`, the relayer sends `lockCoverage` with the countersign and the user's passkey
 * assertion. Every input is fixed by the purchase, so a retry sends the same calldata under the
 * same relayer key.
 */
export async function coverStep(
  deps: CoverStepDeps,
  purchaseId: string,
): Promise<Outcome<{ txId: string | null; txHash: Hex | null }>> {
  const { db, relayer, chain } = deps;
  const out = await countersignOf(db, purchaseId);
  const cs = countersignMessage(out.countersign);
  const operator = deps.operators?.(cs.agentId);
  if (!operator) return final("cover:operator-unavailable");
  if (!relayer || !chain) return final("cover:chain-unavailable");

  const [row] = await db
    .select({
      merchantId: purchases.merchantId,
      rail: purchases.rail,
      payloadSd: mandates.payloadSd,
      disclosures: mandates.disclosures,
      decoySalts: mandates.decoySalts,
      userAuth: mandates.userAuth,
      premiumBps: purchases.premiumBps,
    })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .where(eq(purchases.id, purchaseId));
  // A card merchant is paid by the card network; Keelson, the card program, takes what the
  // coverage pays and makes the user whole.
  const merchant = row
    ? row.rail === "card"
      ? KEELSON_TREASURY
      : SETTLEMENT[row.merchantId]
    : undefined;
  if (!row?.payloadSd || !row.disclosures || !row.userAuth) return final("cover:mandate-unsigned");
  if (!merchant) return final("cover:merchant-unknown");
  const jwk = decodeMandate(row.payloadSd as object, row.disclosures, row.decoySalts).user.cred.jwk;
  const { qx, qy } = passkeyPublicKey(jwk);

  const key = coverageKey(cs.requestId);
  let record: TxRecord | undefined;
  try {
    // The relayer answers a key it already sent with that transaction's record, and takes over
    // a submission whose process died before signing, so every attempt submits.
    const amount = cs.amount * PYUSD_PER_MINOR;
    const bps = await premiumFor(db, purchaseId, cs.agentId, row.premiumBps);
    // A coverage first sent without an attestation keeps none, so every attempt signs the same.
    const amber = await fixAmber(db, purchaseId, !(await relayer.get(CHAIN_ID, key)));
    const coverage: Coverage = {
      coverageId: cs.requestId,
      agentId: cs.agentId,
      merchant,
      amount,
      premium: premiumOf(amount, bps),
      // From the countersign rather than the clock, so every attempt signs the same coverage.
      expiresAt: cs.issuedAt + (await disputeWindow(chain.client)),
      mandateHash: cs.mandateHash,
      amberCommitment: (amber?.commitment as Hex | undefined) ?? ZERO,
      userKeyHash: userKeyHash(qx, qy),
    };
    const operatorSig = await operator.signTypedData(coverageTypedData(coverage, CHAIN_ID, VAULT));
    record = await relayer.submit({
      chainId: CHAIN_ID,
      contract: "KeelsonBondVault",
      functionName: "lockCoverage",
      args: lockCoverageArgs({
        coverage,
        countersign: cs,
        hSd: bytesToHex(hSd(row.payloadSd as object)),
        assertion: row.userAuth as SignedAssertion,
        publicKeyJwk: jwk,
        operatorSig,
        mode: out.mode,
        signatures: out.signatures,
      }),
      key,
      countersignMode: out.mode,
    });
    const deadline = Date.now() + PENDING_WAIT_MS;
    while (record?.status === "pending" && Date.now() < deadline) {
      await sleep(250);
      record = await relayer.getById(record.id);
    }
  } catch (err) {
    if (err instanceof RelayerError) {
      const name = (err.detail as { error?: { name?: string } } | undefined)?.error?.name;
      if (err.code === "simulation-reverted" && name === "CoverageExists") {
        return lockedAlready(chain.client, cs.requestId, cs.agentId);
      }
      if (err.status === 503) return retry(`cover:${err.code}`);
      return final(`cover:${name ?? err.code}`);
    }
    if (unreachable(err)) return retry("cover:chain-unavailable");
    throw err;
  }
  if (!record || record.status === "pending") return retry("cover:pending");
  if (
    record.status === "dropped" ||
    (record.status === "rejected" && RETRYABLE.has(record.errorCode ?? ""))
  ) {
    return retry(`cover:${record.errorCode ?? record.status}`);
  }
  if (record.status !== "confirmed") {
    return final(`cover:${record.error?.name ?? record.errorCode ?? record.status}`);
  }
  const txHash = record.hash ?? null;
  await db
    .update(purchases)
    .set({
      coverageTxId: record.id,
      coverageTxHash: txHash ? Buffer.from(hexToBytes(txHash)) : null,
    })
    .where(eq(purchases.id, purchaseId));
  return done({ txId: record.id, txHash });
}

/** An earlier attempt, through another relayer key or process, locked this coverage. */
async function lockedAlready(
  client: PublicClient,
  coverageId: Hex,
  agentId: bigint,
): Promise<Outcome<{ txId: null; txHash: null }>> {
  const c = await client.readContract({
    address: VAULT,
    abi: keelsonBondVaultAbi,
    functionName: "coverages",
    args: [coverageId],
  });
  return c.status === ACTIVE && BigInt(c.agentId) === agentId
    ? done({ txId: null, txHash: null })
    : final("cover:CoverageExists");
}
