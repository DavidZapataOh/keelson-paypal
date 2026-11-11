import {
  alibis,
  cardAuthorizations,
  cardSettlements,
  type Db,
  eq,
  inArray,
  purchaseCards,
  purchases,
  type StoredCardVerdict,
  teeSigners,
} from "@keelson/db";
import type { Logger } from "pino";
import { getAddress, type Hex, hexToBytes } from "viem";
import { appendStatement, type LogConfig } from "../log/append.ts";
import type { CardStatementRequest } from "../tee/client.ts";
import { legSupportsStatements } from "../tee/coordinator.ts";
import { activeSigner, type TeeConfig } from "../tee/signers.ts";

export interface CardStatementDeps {
  db: Db;
  log: Logger;
  tee?: TeeConfig | undefined;
  tlog?: LogConfig | undefined;
}

type Verdicts = { tdx: StoredCardVerdict | null; nitro: StoredCardVerdict | null };
const hex = (b: Uint8Array | Buffer) => `0x${Buffer.from(b).toString("hex")}` as Hex;

/** The leg that signs a decision's statement: the last that decided (leg B when both did). */
export function signingLeg(v: Verdicts): "a" | "b" | null {
  if (!v.tdx) return null;
  return v.nitro ? "b" : "a";
}

/** The request for a decision's statement, from the legs' stored answers. */
export function cardStatementRequest(o: {
  verdicts: Verdicts;
  measurements: { tdx: Hex; nitro: Hex | null };
  parent: Hex;
  issuer: string;
  cardToken: string;
  refSalt: Hex;
  chainId: number;
}): CardStatementRequest {
  const { tdx, nitro } = o.verdicts;
  if (!tdx) throw new TypeError("a decision without leg A's answer");
  return {
    authorization: tdx.authorization,
    signatures: { tdx: tdx.signature as Hex, ...(nitro ? { nitro: nitro.signature as Hex } : {}) },
    measurements: {
      tdx: o.measurements.tdx,
      ...(o.measurements.nitro ? { nitro: o.measurements.nitro } : {}),
    },
    parent: o.parent,
    issuer: o.issuer,
    card_token: o.cardToken,
    ref_salt: o.refSalt,
    chain_id: o.chainId,
  };
}

/**
 * What the hold is collected for: the legs' signed settlement when there is one, the issuer's word
 * otherwise (legs that predate signed settlements), never above what both legs approved.
 */
export function collectedMinor(approved: bigint, signed: bigint | null, reported: number): bigint {
  const settled = signed ?? BigInt(reported);
  return settled < approved ? settled : approved;
}

/** The registry measurement of each signer, as 32 bytes. */
async function measurementsOf(db: Db, signers: (string | undefined)[]) {
  const addresses = signers
    .filter((s): s is string => !!s)
    .map((s) => Buffer.from(hexToBytes(getAddress(s as Hex))));
  const rows = addresses.length
    ? await db
        .select({ address: teeSigners.address, measurement: teeSigners.measurement })
        .from(teeSigners)
        .where(inArray(teeSigners.address, addresses))
    : [];
  const of = (s: string | undefined) => {
    const id = rows.find((r) => s && hex(r.address).toLowerCase() === s.toLowerCase())?.measurement;
    return id && /^(tdx|nitro):[0-9a-f]{64}$/.test(id) ? (`0x${id.split(":")[1]}` as Hex) : null;
  };
  return { tdx: of(signers[0]), nitro: of(signers[1]) };
}

/** The purchase facts every card statement links to: its leaf, card, salt, chain and countersign. */
async function purchaseLink(db: Db, purchaseId: string) {
  const [row] = await db
    .select({
      leafHash: alibis.leafHash,
      salt: purchases.paypalRefSalt,
      chainId: purchases.chainId,
      countersign: purchases.countersign,
      issuer: purchaseCards.issuer,
      cardToken: purchaseCards.cardToken,
    })
    .from(purchases)
    .innerJoin(alibis, eq(alibis.purchaseId, purchases.id))
    .innerJoin(purchaseCards, eq(purchaseCards.purchaseId, purchases.id))
    .where(eq(purchases.id, purchaseId));
  if (!row?.salt || !row.countersign || !row.cardToken) return null;
  return {
    parent: hex(row.leafHash),
    refSalt: hex(row.salt),
    chainId: row.chainId ?? 421614,
    countersign: row.countersign as Record<string, string>,
    issuer: row.issuer,
    cardToken: row.cardToken,
  };
}

/**
 * Logs a card network authorization decision as its own statement, once its purchase leaf is in the
 * log. Never on the issuer's real-time path; a decision not logged yet is logged when its Alibi is
 * loaded. Legs that predate card statements are skipped.
 */
export async function logCardAuthorization(
  deps: CardStatementDeps,
  authorizationId: string,
): Promise<void> {
  const { db, tee, tlog } = deps;
  if (!tee || !tlog) return;
  const [a] = await db
    .select()
    .from(cardAuthorizations)
    .where(eq(cardAuthorizations.id, authorizationId));
  if (!a || a.statement) return;
  const verdicts = { tdx: a.tdx, nitro: a.nitro };
  const leg = signingLeg(verdicts);
  if (!leg || !(await legSupportsStatements({ tee }, leg))) return;
  const link = await purchaseLink(db, a.purchaseId);
  if (!link) return;
  const measurements = await measurementsOf(db, [verdicts.tdx?.signer, verdicts.nitro?.signer]);
  if (!measurements.tdx) return;
  const { statement } = await tee.client[leg].cardStatement(
    cardStatementRequest({
      verdicts,
      measurements: { tdx: measurements.tdx, nitro: measurements.nitro },
      ...link,
    }),
  );
  const bytes = Buffer.from(statement, "base64");
  const result = await appendStatement({ db, tlog }, a.purchaseId, bytes, link.countersign);
  await db
    .update(cardAuthorizations)
    .set({ statement: bytes, receipt: result.receipt ? Buffer.from(result.receipt) : null })
    .where(eq(cardAuthorizations.id, authorizationId));
}

/**
 * Has the legs read and sign a card settlement: leg A from the issuer, leg B over leg A's reading.
 * Logs the statement and returns the signed amount; `null` when the legs predate it.
 */
export async function settleCard(
  deps: CardStatementDeps,
  purchaseId: string,
  transactionToken: string,
): Promise<{ settledMinor: bigint } | null> {
  const { db, tee, tlog } = deps;
  if (!tee || !tlog || !(await legSupportsStatements({ tee }, "a"))) return null;
  const link = await purchaseLink(db, purchaseId);
  if (!link) return null;
  const ask = {
    request_id: purchaseId,
    transaction_token: transactionToken,
    card_token: link.cardToken,
    issuer: link.issuer,
    parent: link.parent,
    ref_salt: link.refSalt,
    chain_id: link.chainId,
  };
  const [signerA, signerB] = await Promise.all([activeSigner(db, 1), activeSigner(db, 2)]);
  const legsMeasurements = await measurementsOf(db, [signerA?.address, signerB?.address]);
  if (!legsMeasurements.tdx) return null;
  const m = {
    tdx: legsMeasurements.tdx,
    ...(legsMeasurements.nitro ? { nitro: legsMeasurements.nitro } : {}),
  };
  const a = await tee.client.a.cardSettlement({ ...ask, measurements: m });
  let statement = a.statement;
  if (legsMeasurements.nitro && (await legSupportsStatements({ tee }, "b"))) {
    try {
      const b = await tee.client.b.cardSettlement({
        ...ask,
        measurements: m,
        observation: a.observation,
        leg_a: { signer: a.signer, signature: a.signature },
      });
      statement = b.statement;
    } catch (err) {
      deps.log.warn({ err, purchaseId }, "leg b did not sign the card settlement");
    }
  }
  const bytes = Buffer.from(statement, "base64");
  let receipt: Uint8Array | undefined;
  try {
    receipt = (await appendStatement({ db, tlog }, purchaseId, bytes, link.countersign)).receipt;
  } catch (err) {
    deps.log.error({ err, purchaseId }, "card settlement statement not logged");
  }
  const settledMinor = BigInt(a.settlement.settledMinor);
  await db
    .insert(cardSettlements)
    .values({
      purchaseId,
      transactionToken,
      transaction: Buffer.from(a.observation.transaction, "base64"),
      card: Buffer.from(a.observation.card, "base64"),
      settledMinor,
      statement: bytes,
      receipt: receipt ? Buffer.from(receipt) : null,
    })
    .onConflictDoNothing();
  return { settledMinor };
}
