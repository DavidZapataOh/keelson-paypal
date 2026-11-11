import { countersignDigest, keelsonDomain } from "@keelson/core/eip712";
import {
  and,
  type Db,
  eq,
  inArray,
  purchaseCards,
  purchases,
  teeSignatures,
  teeSigners,
} from "@keelson/db";
import {
  cardRefCommit,
  type LeafFormatError,
  leafBytes,
  leafFromCountersign,
  parseStatementLeaf,
  paypalRefCommit,
} from "@keelson/log";
import { type Address, getAddress, type Hex, recoverAddress, toHex } from "viem";
import type { CountersignJson } from "../tee/client.ts";
import { VERIFYING_CONTRACT } from "../tee/config.ts";
import { countersignMessage } from "../tee/coordinator.ts";

/** The coordinator's output for a purchase, rebuilt from what Postgres keeps of it. */
export interface StoredCountersign {
  countersign: CountersignJson;
  digest: Hex;
  mode: "2of2" | "degraded";
  signatures: { tdx: Hex; nitro: Hex | null };
  signers: { tdx: Address; nitro: Address | null };
}

const TDX = 1;
const NITRO = 2;

/**
 * Rebuilds the countersign of a purchase from `purchases.countersign` and `tee_signatures`, so a
 * resumed purchase needs nothing the original response held. The message must hash to the stored
 * digest and each signature must recover to its signer.
 *
 * @throws when the purchase has no countersign or what is stored does not hold together.
 */
export async function countersignOf(db: Db, purchaseId: string): Promise<StoredCountersign> {
  const [p] = await db
    .select({
      countersign: purchases.countersign,
      digest: purchases.countersignDigest,
      mode: purchases.countersignMode,
    })
    .from(purchases)
    .where(eq(purchases.id, purchaseId));
  if (!p?.countersign || !p.digest || (p.mode !== "2of2" && p.mode !== "degraded")) {
    throw new Error(`purchase ${purchaseId} has no countersign`);
  }
  const countersign = p.countersign as unknown as CountersignJson;
  const digest = toHex(p.digest);
  const computed = countersignDigest(
    countersignMessage(countersign),
    keelsonDomain(421614, VERIFYING_CONTRACT),
  );
  if (computed !== digest) throw new Error(`purchase ${purchaseId}: countersign digest mismatch`);

  const rows = await db
    .select({
      kind: teeSigners.teeKind,
      signer: teeSignatures.signer,
      signature: teeSignatures.signature,
    })
    .from(teeSignatures)
    .innerJoin(teeSigners, eq(teeSigners.address, teeSignatures.signer))
    .where(and(eq(teeSignatures.requestId, purchaseId), eq(teeSignatures.digest, p.digest)));
  const of = (kind: number) => rows.find((r) => r.kind === kind);
  const tdx = of(TDX);
  const nitro = of(NITRO);
  if (!tdx || (p.mode === "2of2") !== (nitro !== undefined)) {
    throw new Error(`purchase ${purchaseId}: countersignatures do not match its mode`);
  }
  for (const r of [tdx, nitro]) {
    if (!r) continue;
    const recovered = await recoverAddress({ hash: digest, signature: toHex(r.signature) });
    if (recovered !== getAddress(toHex(r.signer))) {
      throw new Error(`purchase ${purchaseId}: a countersignature is not its signer's`);
    }
  }
  return {
    countersign,
    digest,
    mode: p.mode,
    signatures: { tdx: toHex(tdx.signature), nitro: nitro ? toHex(nitro.signature) : null },
    signers: {
      tdx: getAddress(toHex(tdx.signer)),
      nitro: nitro ? getAddress(toHex(nitro.signer)) : null,
    },
  };
}

/**
 * The Alibi leaf of a purchase: its countersign, the measurements its signers were admitted with
 * and the commitment to its PayPal order and authorization, or to its single-use card.
 */
/**
 * A purchase's SCITT statement as its v2 leaf, once it is the statement of `out`: the same
 * countersign, mode and legs' signatures, its own signatures verifying.
 *
 * @throws when the statement is malformed or names another countersign, mode or signature.
 */
export function statementLeaf(statement: Uint8Array, out: StoredCountersign): Uint8Array {
  let parsed: ReturnType<typeof parseStatementLeaf>;
  try {
    parsed = parseStatementLeaf(statement);
  } catch (err) {
    throw new Error(`the stored statement does not verify: ${(err as LeafFormatError).message}`);
  }
  if (parsed.kind !== "purchase") throw new Error("the stored statement is not a purchase's");
  const c = parsed.claims.countersign;
  const same = Object.entries(out.countersign).every(
    ([k, v]) => String((c as Record<string, unknown>)[k]).toLowerCase() === String(v).toLowerCase(),
  );
  if (!same) throw new Error("the stored statement names another countersign");
  if (parsed.claims.mode !== out.mode) throw new Error("the stored statement has another mode");
  const sigs = [out.signatures.tdx, out.signatures.nitro].filter((s) => s !== null);
  const legs = parsed.claims.legs.map((l) => l.signature.toLowerCase());
  if (sigs.length !== legs.length || sigs.some((s, i) => s.toLowerCase() !== legs[i])) {
    throw new Error("the stored statement carries another signature");
  }
  return statement;
}

export async function purchaseLeaf(
  db: Db,
  purchaseId: string,
  out: StoredCountersign,
): Promise<Uint8Array> {
  const [p] = await db
    .select({
      statement: purchases.statement,
      salt: purchases.paypalRefSalt,
      rail: purchases.rail,
      orderId: purchases.paypalOrderId,
      authorizationId: purchases.paypalAuthorizationId,
      issuer: purchaseCards.issuer,
      cardToken: purchaseCards.cardToken,
    })
    .from(purchases)
    .leftJoin(purchaseCards, eq(purchaseCards.purchaseId, purchases.id))
    .where(eq(purchases.id, purchaseId));
  if (p?.statement) return statementLeaf(new Uint8Array(p.statement), out);
  let ref: Hex;
  if (p?.salt && p.rail === "card" && p.issuer && p.cardToken) {
    ref = cardRefCommit(p.salt, p.issuer, p.cardToken);
  } else if (p?.salt && p.rail === "paypal" && p.orderId && p.authorizationId) {
    ref = paypalRefCommit(p.salt, p.orderId, p.authorizationId);
  } else {
    throw new Error(`purchase ${purchaseId} has no payment reference`);
  }
  const addresses = [out.signers.tdx, out.signers.nitro].filter((a) => a !== null);
  const signers = await db
    .select({ address: teeSigners.address, measurement: teeSigners.measurement })
    .from(teeSigners)
    .where(
      inArray(
        teeSigners.address,
        addresses.map((a) => Buffer.from(a.slice(2), "hex")),
      ),
    );
  const measurementOf = (a: Address | null) =>
    a === null
      ? null
      : (signers.find((s) => getAddress(toHex(s.address)) === a)?.measurement ?? null);
  const tdx = measurementOf(out.signers.tdx);
  if (!tdx) throw new Error(`purchase ${purchaseId}: the TDX signer is not admitted`);
  return leafBytes(
    leafFromCountersign(
      countersignMessage(out.countersign),
      out.digest,
      out.mode,
      out.signatures,
      { tdx, nitro: measurementOf(out.signers.nitro) },
      ref,
    ),
  );
}
