import { randomBytes } from "node:crypto";
import { AMBER_STRING_BYTES, type Amber, amberCommitment, amberProduct } from "@keelson/core/amber";
import {
  amberConvictions,
  and,
  type Db,
  eq,
  evidenceItems,
  inArray,
  purchases,
  type StoredAmber,
  sql,
} from "@keelson/db";
import { CHAINS } from "@keelson/relayer";
import { MERCHANTS } from "./merchants.ts";

const fits = (s: unknown): s is string =>
  typeof s === "string" && s !== "" && new TextEncoder().encode(s).length <= AMBER_STRING_BYTES;

/**
 * What the operator attests about a one-line cart from an onboarded store: the line's SKU, size,
 * color and unit price and the cart's free returns, and the store's JSON page for that SKU, where
 * a TLSNotary session can read what the store itself says. `undefined` when the cart has more
 * lines, a line without size or color, or a product page outside the merchant's website.
 */
export function amberOf(
  merchantId: string,
  cart: unknown,
  product: unknown,
): { url: URL; amber: Amber } | undefined {
  const website = MERCHANTS.find((m) => m.id === merchantId)?.website;
  const c = cart as {
    merchant?: unknown;
    lines?: { sku?: unknown; size?: unknown; color?: unknown; unit_minor?: unknown }[];
    returns_free?: unknown;
  } | null;
  const p = product as { url?: unknown; handle?: unknown } | null;
  const line = c?.lines?.length === 1 ? c.lines[0] : undefined;
  if (!website || c?.merchant !== merchantId || !line || typeof p?.url !== "string") {
    return undefined;
  }
  if (!fits(line.sku) || !fits(line.size) || !fits(line.color)) return undefined;
  if (!Number.isSafeInteger(line.unit_minor) || (line.unit_minor as number) < 0) return undefined;
  if (typeof c.returns_free !== "boolean" || typeof p.handle !== "string") return undefined;
  let page: URL;
  try {
    page = new URL(p.url);
  } catch {
    return undefined;
  }
  const origin = new URL(website).origin;
  if (page.origin !== origin || !/^[a-z0-9-]+$/.test(p.handle)) return undefined;
  return {
    url: new URL(`/api/products/${p.handle}/variants/${encodeURIComponent(line.sku)}`, origin),
    amber: {
      sku: line.sku,
      size: line.size,
      color: line.color,
      unitMinor: BigInt(line.unit_minor as number),
      returnsFree: c.returns_free,
    },
  };
}

/** 31 random bytes: a salt below the BN254 scalar field. */
const newSalt = () => BigInt(`0x${randomBytes(31).toString("hex")}`);
const hex32 = (x: bigint) => `0x${x.toString(16).padStart(64, "0")}`;

/**
 * The purchase's amber attestation, made from its evidence's `api.cart` and `api.product` items on
 * the first call and fixed on the purchase, so that every cover attempt signs the same
 * `amberCommitment`. `null` when the purchase's cart is not one {@link amberOf} attests.
 */
export async function fixAmber(db: Db, purchaseId: string): Promise<StoredAmber | null> {
  const [row] = await db
    .select({
      amber: purchases.amber,
      merchantId: purchases.merchantId,
      evidenceRoot: purchases.evidenceRoot,
    })
    .from(purchases)
    .where(eq(purchases.id, purchaseId));
  if (!row) throw new Error(`purchase ${purchaseId} is unknown`);
  if (row.amber) return row.amber;
  if (!row.evidenceRoot) return null;
  const items = await db
    .select({ type: evidenceItems.type, bytes: evidenceItems.bytes })
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.root, row.evidenceRoot),
        inArray(evidenceItems.type, ["api.cart", "api.product"]),
      ),
    );
  const json = (type: string) => {
    const bytes = items.find((i) => i.type === type)?.bytes;
    try {
      return bytes ? (JSON.parse(bytes.toString("utf8")) as unknown) : undefined;
    } catch {
      return undefined;
    }
  };
  const attested = amberOf(row.merchantId, json("api.cart"), json("api.product"));
  if (!attested) return null;
  const { url, amber } = attested;
  const salt = newSalt();
  const stored: StoredAmber = {
    url: url.href,
    sku: amber.sku,
    size: amber.size,
    color: amber.color,
    unit_minor: amber.unitMinor.toString(),
    returns_free: amber.returnsFree,
    salt: hex32(salt),
    commitment: hex32(await amberCommitment(amberProduct(url), amber, salt)),
  };
  const [fixed] = await db
    .update(purchases)
    .set({ amber: sql`coalesce(${purchases.amber}, ${JSON.stringify(stored)}::jsonb)` })
    .where(eq(purchases.id, purchaseId))
    .returning({ amber: purchases.amber });
  return fixed?.amber ?? stored;
}

/** The amber fields by the C2b field id a conviction names. */
export const AMBER_FIELD = ["size", "color", "unit_price", "returns_free"] as const;

/** A purchase's amber attestation and the court's conviction of it, as dispute data shows them. */
export interface AmberCase {
  commitment: string;
  attested: Omit<StoredAmber, "salt" | "commitment">;
  conviction: {
    field: (typeof AMBER_FIELD)[number];
    /** What the operator attested of the field, which the store's own answer contradicted. */
    attested_value: string;
    proven_at: string;
    web_fact_digest: string;
    /** When leg A notarized the store's answer. */
    captured_at: string | null;
    tx_hash: string;
    explorer_url: string;
    proof: { bytes: number; hash: string; public_inputs: string[] } | null;
  } | null;
}

const hex = (b: Buffer) => `0x${b.toString("hex")}`;

/** The amber cases of `purchaseIds`, read from the purchases and the projected convictions. */
export async function amberCases(
  db: Db,
  purchaseIds: readonly string[],
): Promise<Map<string, AmberCase>> {
  const out = new Map<string, AmberCase>();
  if (purchaseIds.length === 0) return out;
  const ids = [...new Set(purchaseIds)];
  const [attested, convicted] = await Promise.all([
    db
      .select({ id: purchases.id, amber: purchases.amber })
      .from(purchases)
      .where(and(inArray(purchases.id, ids), sql`${purchases.amber} is not null`)),
    db.select().from(amberConvictions).where(inArray(amberConvictions.purchaseId, ids)),
  ]);
  for (const { id, amber } of attested) {
    if (!amber) continue;
    const { salt: _salt, commitment, ...fields } = amber;
    const v = convicted.find((c) => c.purchaseId === id);
    const field = v ? AMBER_FIELD[v.fieldId - 1] : undefined;
    const tx = v ? hex(v.txHash) : undefined;
    out.set(id, {
      commitment,
      attested: fields,
      conviction:
        v && field && tx
          ? {
              field,
              attested_value: String(
                {
                  size: fields.size,
                  color: fields.color,
                  unit_price: fields.unit_minor,
                  returns_free: fields.returns_free,
                }[field],
              ),
              proven_at: v.provenAt.toISOString(),
              web_fact_digest: hex(v.webFactDigest),
              captured_at: v.proof
                ? new Date(Number(v.proof.fact.t_capture) * 1000).toISOString()
                : null,
              tx_hash: tx,
              explorer_url: `${CHAINS[421614].explorer}/tx/${tx}`,
              proof: v.proof
                ? { bytes: v.proof.bytes, hash: v.proof.hash, public_inputs: v.proof.public_inputs }
                : null,
            }
          : null,
    });
  }
  return out;
}
