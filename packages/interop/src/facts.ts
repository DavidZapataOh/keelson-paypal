import {
  ALIBI_MEDIA_TYPE_V2,
  type AlibiBundle,
  type AlibiBundleV2,
  registeredOf,
} from "@keelson/alibi";
import { type Cart, CURRENCIES, type CurrencyCode, fromPayPalAmount } from "@keelson/core";
import { parseStatementLeaf, ulidOfRequestId } from "@keelson/log";
import { type Disclosed, decodeDisclosed, type Mandate, type UserAuth } from "@keelson/mandate";
import { ExportRefused } from "./signer.ts";

/**
 * One purchased line, in minor units of the purchase currency.
 *
 * @internal
 */
export interface Line {
  sku: string;
  title: string;
  quantity: number;
  unitMinor: number;
}

/**
 * A merchant as the standards name it.
 *
 * @internal
 */
export interface Merchant {
  id: string;
  name: string;
  website?: string;
}

/**
 * What an Alibi proves about one purchase. Amount, currency, times, hashes and decision are the
 * enclaves' countersigned values; lines, breakdown and personal data exist only when the Alibi
 * discloses them, and are never derived from other fields.
 */
export interface PurchaseFacts {
  alibiId: string;
  requestId: `0x${string}`;
  decision: "allow" | "deny";
  failedFieldsMask: string;
  /** Seconds since the epoch. */
  issuedAt: number;
  expiresAt: number;
  /** ISO 4217, upper case. */
  currency: string;
  totalMinor: number;
  merchant: Merchant;
  /** The PayPal merchant id, or the card network's merchant id. */
  payee: string;
  rail: "paypal" | "card";
  /** The PayPal capture id, or the approved card authorization's id. */
  confirmationId?: string;
  /** The PayPal authorization id, or the approved card authorization's id. */
  authorizationId?: string;
  orderId?: string;
  card?: { issuer: string; lastFour: string };
  lines?: Line[];
  breakdown?: { items: number; tax: number; shipping: number; discount: number };
  mandateHash: `0x${string}`;
  cartHash: `0x${string}`;
  /** The countersigned agent id, decimal. */
  agentId: string;
  /** The countersigned merchant id hash. */
  merchantIdHash: `0x${string}`;
  mandate: Disclosed<Mandate>;
  /** The open mandate as the enclave issued it. */
  l2: string;
  userAuth: UserAuth;
  personal?: { appLoginId?: string; deviceFp?: string; ip?: string };
  env: "sandbox" | "live";
  /** The Alibi's format: 1, or 2 for a SCITT Transparent Statement. */
  version: 1 | 2;
}

/** The facts of a purchase's logged statement, as the issuer compares them before it signs. */
export interface StatementFacts {
  /** The countersigned request id as a ULID. */
  request_id: string;
  mandate_hash: string;
  cart_hash: string;
  /** Decimal. */
  agent_id: string;
  merchant_id: string;
  /** Decimal. */
  amount_minor: string;
  /** ISO 4217 numeric, decimal. */
  currency: string;
  decision: "allow" | "deny";
  /** Seconds since the epoch. */
  issued_at: number;
}

interface CardSection {
  issuer: string;
  last_four: string;
  authorizations: {
    id: string;
    approved: boolean;
    merchant_name: string;
    network_id: string;
  }[];
}

const ARBITRUM_ONE = 42161;

function alphaOf(numeric: string): string {
  const code = (Object.keys(CURRENCIES) as CurrencyCode[]).find(
    (c) => String(CURRENCIES[c].numeric) === numeric,
  );
  if (!code) throw new ExportRefused("unsupported_currency");
  return code;
}

/** The allowed merchant with `id`, from the disclosed `checkout.allowed_merchants`. */
function allowedMerchant(m: Disclosed<Mandate>, id: string): Merchant | undefined {
  for (const c of m.checkout?.constraints ?? []) {
    if (c?.type !== "checkout.allowed_merchants") continue;
    const found = (c.allowed ?? []).find((x) => x?.id === id);
    if (found?.id && found.name) {
      return {
        id: found.id,
        name: found.name,
        ...(found.website ? { website: found.website } : {}),
      };
    }
  }
  return undefined;
}

/** Titles of the acceptable items the mandate discloses, by id. */
function itemTitles(m: Disclosed<Mandate>): Map<string, string> {
  const titles = new Map<string, string>();
  for (const c of m.checkout?.constraints ?? []) {
    if (c?.type !== "checkout.line_items") continue;
    for (const line of c.items ?? []) {
      for (const a of line?.acceptable_items ?? []) {
        if (a?.id && a.title) titles.set(a.id, a.title);
      }
    }
  }
  return titles;
}

/** The countersign of an Alibi, as decimal strings and hex, and its chain. */
function countersignOf(b: AlibiBundle | AlibiBundleV2) {
  if (b.type !== ALIBI_MEDIA_TYPE_V2) {
    const v1 = b as AlibiBundle;
    return { cs: v1.tee.countersign, chainId: v1.tee.domain.chain_id, version: 1 as const };
  }
  const parsed = parseStatementLeaf(registeredOf(b as AlibiBundleV2));
  if (parsed.kind !== "purchase" && parsed.kind !== "bridge")
    throw new ExportRefused("not_a_purchase");
  const c = parsed.claims.countersign;
  const cs = Object.fromEntries(
    Object.entries(c).map(([k, v]) => [k, typeof v === "string" ? v.toLowerCase() : String(v)]),
  ) as AlibiBundle["tee"]["countersign"];
  return { cs, chainId: parsed.claims.chainId, version: 2 as const };
}

/** Reads an Alibi's purchase into the facts the exports state; a v2 Alibi's countersign comes from its statement. */
export function purchaseFacts(b: AlibiBundle | AlibiBundleV2): PurchaseFacts {
  const { cs, chainId, version } = countersignOf(b);
  const mandate = decodeDisclosed(b.mandate.payload_sd, b.mandate.disclosures);
  const cart = b.cart as unknown as Cart | undefined;
  const card = b.card as unknown as CardSection | undefined;
  const approved = card?.authorizations.find((a) => a.approved);
  const ctxMerchant = (b.eval.context as { merchant?: string }).merchant;
  const titles = itemTitles(mandate);

  let merchant: Merchant;
  let payee: string;
  if (card) {
    const auth = approved ?? card.authorizations[0];
    merchant = { id: auth?.network_id ?? "", name: auth?.merchant_name ?? "" };
    payee = merchant.id;
  } else {
    const id = cart?.merchant ?? ctxMerchant ?? "";
    merchant = allowedMerchant(mandate, id) ?? { id, name: id };
    payee = b.paypal?.merchant_id ?? "";
  }

  const confirmationId = card ? approved?.id : b.paypal?.capture_id;
  const authorizationId = card ? approved?.id : b.paypal?.authorization_id;
  const total = b.checkout ? fromPayPalAmount(b.checkout, cart) : undefined;
  const personal = {
    ...(mandate.user?.app_login_id ? { appLoginId: mandate.user.app_login_id } : {}),
    ...(mandate.risk_data?.device_fp ? { deviceFp: mandate.risk_data.device_fp } : {}),
    ...(mandate.risk_data?.ip ? { ip: mandate.risk_data.ip } : {}),
  };

  return {
    alibiId: b.alibi_id,
    requestId: cs.requestId as `0x${string}`,
    decision: cs.decision === "1" ? "allow" : "deny",
    failedFieldsMask: cs.failedFieldsMask,
    issuedAt: Number(cs.issuedAt),
    expiresAt: Number(cs.expiresAt),
    currency: alphaOf(cs.currency),
    totalMinor: Number(cs.amount),
    merchant,
    payee,
    rail: card ? "card" : "paypal",
    ...(confirmationId ? { confirmationId } : {}),
    ...(authorizationId ? { authorizationId } : {}),
    ...(!card && b.paypal?.order_id ? { orderId: b.paypal.order_id } : {}),
    ...(card ? { card: { issuer: card.issuer, lastFour: card.last_four } } : {}),
    ...(cart
      ? {
          lines: cart.lines.map((l) => ({
            sku: l.sku,
            title: titles.get(l.sku) ?? l.sku,
            quantity: l.qty,
            unitMinor: l.unit_minor,
          })),
        }
      : {}),
    ...(total
      ? {
          breakdown: {
            items: Number(total.items),
            tax: Number(total.tax),
            shipping: Number(total.shipping),
            discount: Number(total.discount),
          },
        }
      : {}),
    mandateHash: cs.mandateHash as `0x${string}`,
    cartHash: cs.cartHash as `0x${string}`,
    agentId: cs.agentId,
    merchantIdHash: cs.merchantId as `0x${string}`,
    mandate,
    l2: b.mandate.sd_jwt,
    userAuth: b.mandate.user_auth as unknown as UserAuth,
    ...(Object.keys(personal).length ? { personal } : {}),
    env: chainId === ARBITRUM_ONE ? "live" : "sandbox",
    version,
  };
}

/** The facts the issuer binds an export to. */
export function statementFacts(f: PurchaseFacts): StatementFacts {
  const numeric = CURRENCIES[f.currency as CurrencyCode]?.numeric;
  if (numeric === undefined) throw new ExportRefused("unsupported_currency");
  return {
    request_id: ulidOfRequestId(f.requestId),
    mandate_hash: f.mandateHash,
    cart_hash: f.cartHash,
    agent_id: f.agentId,
    merchant_id: f.merchantIdHash,
    amount_minor: String(f.totalMinor),
    currency: String(numeric),
    decision: f.decision,
    issued_at: f.issuedAt,
  };
}
