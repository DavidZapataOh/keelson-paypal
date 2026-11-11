import { CURRENCIES, type CurrencyCode } from "@keelson/core";
import type { Disclosed, Mandate } from "@keelson/mandate";
import type { Merchant, PurchaseFacts } from "./facts.ts";
import {
  type Disclosure,
  disclose,
  disclosedPayload,
  type EcPublicJwk,
  hashB64u,
  ref,
  type Signer,
  sdJwt,
  signJwt,
} from "./jose.ts";
import { type Normalized, normalize } from "./normalize.ts";

/**
 * AP2 v0.2 (github.com/google-agentic-commerce/AP2, tag v0.2.0): open mandates issued by the
 * trusted surface, closed mandates the agent signs on top, and receipts bound to them.
 */

/** AP2 `types/amount.json`: integer minor units. */
interface Amount {
  amount: number;
  currency: string;
}

/** AP2 `types/payment_instrument.json`. */
export interface PaymentInstrument {
  id: string;
  type: string;
  description?: string;
}

/** An AP2 `mandate.checkout.open.1` or `mandate.payment.open.1` payload, before disclosure. */
type OpenMandate = Record<string, unknown> & { vct: string; cnf: { jwk: EcPublicJwk } };

/** The open mandates as SD-JWTs, and what AP2 cannot state of the Keelson mandate. */
export interface Ap2Open {
  /** `mandate.checkout.open.1`, an SD-JWT signed by the trusted surface. */
  checkout: string;
  /** `mandate.payment.open.1`, whose `payment.reference` is `sd_hash` of `checkout`. */
  payment: string;
  notes: string[];
}

/** The closed mandates, each a dSD-JWT chain `open~~closed`, and the checkout JWT they bind. */
export interface Ap2Closed {
  checkout: string;
  payment: string;
  checkoutJwt: string;
}

const RECEIPT_TYP = "JWT";

/** The minor units of `minor` as a decimal amount of `currency`. */
const major = (minor: number, currency: string): number =>
  minor / 10 ** (CURRENCIES[currency as CurrencyCode]?.exponent ?? 2);

/**
 * The `mandate.checkout.open.1` payload. AP2 requires a `checkout.line_items` constraint, so a
 * mandate without one exports a single line of any item, which AP2 cannot match: such a mandate
 * is only enforceable by Keelson's engine.
 */
function openCheckoutPayload(
  n: Normalized,
  cnf: EcPublicJwk,
  iat: number,
  exp: number,
): OpenMandate {
  const lines =
    n.lines.length > 0
      ? n.lines
      : [{ id: "any", acceptable: [{ id: "*", title: "Any item" }], quantity: 1 }];
  return {
    vct: "mandate.checkout.open.1",
    constraints: [
      {
        type: "checkout.line_items",
        items: lines.map((l) => ({
          id: l.id,
          acceptable_items: l.acceptable,
          quantity: l.quantity,
        })),
      },
      { type: "checkout.allowed_merchants", allowed: n.merchants },
    ],
    cnf: { jwk: cnf },
    iat,
    exp,
  };
}

/**
 * The `mandate.payment.open.1` payload. A Keelson mandate is spent by any number of purchases up
 * to its budget, which AP2 states as `payment.agent_recurrence` `ON_DEMAND` with
 * `payment.budget`. The AP2 SDK reads `payment.budget.max` in major units (it multiplies it by
 * 100), unlike `payment.amount_range`, so the budget is written that way.
 */
function openPaymentPayload(
  n: Normalized,
  cnf: EcPublicJwk,
  iat: number,
  exp: number,
  checkoutReference: string,
  instrument: PaymentInstrument,
): OpenMandate {
  const constraints: Record<string, unknown>[] = [];
  if (n.maxAmount !== undefined) {
    constraints.push({ type: "payment.amount_range", currency: n.currency, max: n.maxAmount });
  }
  if (n.budget !== undefined) {
    constraints.push({ type: "payment.agent_recurrence", frequency: "ON_DEMAND" });
    constraints.push({
      type: "payment.budget",
      max: major(n.budget, n.currency),
      currency: n.currency,
    });
  }
  if (n.payees.length > 0) constraints.push({ type: "payment.allowed_payees", allowed: n.payees });
  if (n.notAfter !== undefined)
    constraints.push({ type: "payment.execution_date", not_after: n.notAfter });
  constraints.push({ type: "payment.allowed_payment_instruments", allowed: [instrument] });
  constraints.push({ type: "payment.reference", conditional_transaction_id: checkoutReference });
  return { vct: "mandate.payment.open.1", constraints, cnf: { jwk: cnf }, iat, exp };
}

/**
 * Makes the `allowed` entries of `allowed_merchants`, `allowed_payees` and
 * `allowed_payment_instruments` and each line's `acceptable_items` selectively disclosable, as
 * the AP2 schemas mark them (`x-selectively-disclosable-array`).
 */
function packOpen(payload: OpenMandate): { packed: OpenMandate; disclosures: Disclosure[] } {
  const disclosures: Disclosure[] = [];
  const hide = (xs: unknown[]) =>
    xs.map((x) => {
      const d = disclose(x);
      disclosures.push(d);
      return ref(d);
    });
  const constraints = (payload.constraints as Record<string, unknown>[]).map((c) => {
    if (c.type === "checkout.line_items") {
      return {
        ...c,
        items: (c.items as { acceptable_items: unknown[] }[]).map((l) => ({
          ...l,
          acceptable_items: hide(l.acceptable_items),
        })),
      };
    }
    return Array.isArray(c.allowed) && c.type !== "payment.allowed_pisps"
      ? { ...c, allowed: hide(c.allowed) }
      : c;
  });
  return { packed: { ...payload, constraints }, disclosures };
}

/** A root SD-JWT whose only claim is `delegate_payload: [payload]`, disclosed as one element. */
async function issueRoot(payload: OpenMandate, signer: Signer): Promise<string> {
  const { packed, disclosures } = packOpen(payload);
  const delegate = disclose(packed);
  const jwt = await signJwt(
    { typ: "dc+sd-jwt", kid: signer.kid },
    { delegate_payload: [ref(delegate)], _sd_alg: "sha-256" },
    signer,
  );
  return sdJwt(jwt, [...disclosures, delegate]);
}

/** The payment instrument a Keelson mandate pays with. */
export function instrumentOf(
  m: Disclosed<Mandate>,
  card?: PurchaseFacts["card"],
): PaymentInstrument {
  if (m.payment?.rail === "card") {
    return card
      ? {
          id: `card:${card.issuer}`,
          type: "card",
          description: `Single-use card •••• ${card.lastFour}`,
        }
      : { id: "card:single-use", type: "card", description: "Single-use card" };
  }
  return { id: "paypal", type: "paypal", description: "PayPal" };
}

/**
 * Issues the AP2 open checkout and payment mandates of a Keelson mandate, signed by `signer`
 * as the trusted surface that collected the user's passkey consent, delegated to the mandate's
 * agent key. Each carries `keelson.mandate_hash`, the `M` the passkey signed, so the export can
 * be re-derived from the signed mandate.
 */
export async function issueAp2Open(
  m: Disclosed<Mandate>,
  signer: Signer,
  opts: { mandateHash: string; instrument?: PaymentInstrument },
): Promise<Ap2Open> {
  const cnf = m.agent?.cnf?.jwk as EcPublicJwk | undefined;
  if (!cnf || m.iat === undefined || m.exp === undefined)
    throw new RangeError("the mandate's agent key and lifetime are undisclosed");
  const n = normalize(m);
  const keelson = { mandate_hash: opts.mandateHash, notes: n.notes };
  const checkout = await issueRoot(
    { ...openCheckoutPayload(n, cnf, m.iat, m.exp), keelson },
    signer,
  );
  const payment = await issueRoot(
    {
      ...openPaymentPayload(
        n,
        cnf,
        m.iat,
        m.exp,
        hashB64u(checkout),
        opts.instrument ?? instrumentOf(m),
      ),
      keelson,
    },
    signer,
  );
  return { checkout, payment, notes: n.notes };
}

/**
 * The UCP Checkout object (AP2 `ucp/types/checkout.json`) of a purchase: what the closed checkout
 * mandate's `checkout_jwt` carries.
 */
export function checkoutObject(f: PurchaseFacts): Record<string, unknown> {
  const subtotal = f.breakdown?.items ?? f.lines.reduce((s, l) => s + l.unitMinor * l.quantity, 0);
  const totals = [
    { type: "subtotal", amount: subtotal },
    ...(f.breakdown?.discount ? [{ type: "discount", amount: -f.breakdown.discount }] : []),
    ...(f.breakdown?.shipping ? [{ type: "fulfillment", amount: f.breakdown.shipping }] : []),
    ...(f.breakdown?.tax ? [{ type: "tax", amount: f.breakdown.tax }] : []),
    { type: "total", amount: f.totalMinor },
  ];
  return {
    id: f.paypal?.order_id ?? f.alibiId,
    merchant: f.merchant,
    line_items: f.lines.map((l, i) => ({
      id: `line_${i + 1}`,
      item: { id: l.sku, title: l.title, price: l.unitMinor },
      quantity: l.quantity,
      totals: [{ type: "total", amount: l.unitMinor * l.quantity }],
    })),
    status: "completed",
    currency: f.currency,
    totals,
    links: [{ type: "receipt", url: `https://api.keelson.finance/v1/alibis/${f.alibiId}` }],
  };
}

/**
 * The checkout JWT of a purchase. AP2 has the merchant sign it; a PayPal merchant signs no
 * checkout, so `signer` signs the checkout Keelson's TEE countersigned, and the header's `kid`
 * names who signed.
 */
export const checkoutJwt = (f: PurchaseFacts, signer: Signer): Promise<string> =>
  signJwt({ typ: "JWT", kid: signer.kid }, checkoutObject(f), signer);

/** The open mandate a root SD-JWT delegates, with its disclosures applied. */
export const openPayload = (token: string): Record<string, unknown> =>
  disclosedPayload<{ delegate_payload: Record<string, unknown>[] }>(token).delegate_payload[0] ??
  {};

/**
 * The closed `mandate.payment.1` payload of a purchase under the open payment mandate `open`:
 * the payee is the allowed payee the PayPal order paid, and the instrument the one it allows.
 */
export function closedPaymentPayload(
  f: PurchaseFacts,
  transactionId: string,
  open: string,
): Record<string, unknown> {
  const constraints = openPayload(open).constraints as { type: string; allowed?: unknown[] }[];
  const allowed = (type: string) => constraints.find((c) => c.type === type)?.allowed;
  const payee =
    (allowed("payment.allowed_payees") as Merchant[] | undefined)?.find((p) => p.id === f.payee) ??
    f.merchant;
  return {
    vct: "mandate.payment.1",
    transaction_id: transactionId,
    payee,
    payment_amount: { amount: f.totalMinor, currency: f.currency } satisfies Amount,
    payment_instrument: (
      allowed("payment.allowed_payment_instruments") as PaymentInstrument[] | undefined
    )?.[0],
  };
}

/**
 * A terminal hop (`typ` `kb+sd-jwt`) on `open`: `delegate_payload: [closed]`, signed by the
 * agent key the open mandate's `cnf` names, bound to `open` with `sd_hash`.
 */
async function closeHop(
  open: string,
  closed: Record<string, unknown>,
  agent: Signer,
  opts: { aud: string; nonce: string; iat: number; sdField?: string },
): Promise<string> {
  const disclosures: Disclosure[] = [];
  let payload = closed;
  if (opts.sdField !== undefined) {
    const { [opts.sdField]: value, ...rest } = closed;
    const d = disclose(value, opts.sdField);
    disclosures.push(d);
    payload = { ...rest, _sd: [d.digest] };
  }
  const delegate = disclose(payload);
  const jwt = await signJwt(
    { typ: "kb+sd-jwt", kid: agent.kid },
    {
      delegate_payload: [ref(delegate)],
      iat: opts.iat,
      aud: opts.aud,
      nonce: opts.nonce,
      sd_hash: hashB64u(open),
      _sd_alg: "sha-256",
    },
    agent,
  );
  return `${open.slice(0, -1)}~~${sdJwt(jwt, [delegate, ...disclosures])}`;
}

/**
 * Closes the open mandates for one purchase with the agent's key: the checkout chain for the
 * merchant (`aud` `merchant`) and the payment chain for the credential provider (`aud` `paypal`).
 * `checkoutJwt` is the checkout both bind to, by `checkout_hash` and `transaction_id`.
 */
export async function closeAp2(
  open: Pick<Ap2Open, "checkout" | "payment">,
  f: PurchaseFacts,
  checkoutJwtValue: string,
  agent: Signer,
  opts: { nonce: string; iat: number; merchantAud?: string; paymentAud?: string },
): Promise<Ap2Closed> {
  const checkoutHash = hashB64u(checkoutJwtValue);
  const checkout = await closeHop(
    open.checkout,
    { vct: "mandate.checkout.1", checkout_jwt: checkoutJwtValue, checkout_hash: checkoutHash },
    agent,
    {
      aud: opts.merchantAud ?? "merchant",
      nonce: opts.nonce,
      iat: opts.iat,
      sdField: "checkout_jwt",
    },
  );
  const payment = await closeHop(
    open.payment,
    closedPaymentPayload(f, checkoutHash, open.payment),
    agent,
    {
      aud: opts.paymentAud ?? "paypal",
      nonce: opts.nonce,
      iat: opts.iat,
    },
  );
  return { checkout, payment, checkoutJwt: checkoutJwtValue };
}

/** `b64url(sha256(leaf JWT))`, the AP2 receipt `reference` of a closed mandate chain. */
export const receiptReference = (chain: string): string =>
  hashB64u((chain.split("~~").at(-1) ?? "").split("~")[0] ?? "");

/**
 * The AP2 checkout and payment receipts of a captured purchase, as `iss` observed it: the PayPal
 * order is the checkout's order, the capture the payment.
 */
export async function ap2Receipts(
  closed: Pick<Ap2Closed, "checkout" | "payment">,
  f: PurchaseFacts,
  signer: Signer,
  opts: { iss: string; iat: number },
): Promise<{ checkout: string; payment: string }> {
  const base = { iss: opts.iss, iat: opts.iat };
  const orderId = f.paypal?.order_id ?? f.alibiId;
  const captured = f.paypal?.capture_id;
  const checkout = {
    ...base,
    status: "Success",
    reference: receiptReference(closed.checkout),
    order_id: orderId,
  };
  const payment = captured
    ? {
        ...base,
        status: "Success",
        reference: receiptReference(closed.payment),
        payment_id: f.alibiId,
        psp_confirmation_id: captured,
        network_confirmation_id: f.paypal?.transaction_id ?? captured,
      }
    : {
        ...base,
        status: "Error",
        reference: receiptReference(closed.payment),
        payment_id: f.alibiId,
        error: f.decision === "deny" ? "declined" : "not_captured",
        error_description:
          f.decision === "deny"
            ? "Keelson's countersign declined the cart."
            : "The payment has not been captured.",
      };
  return {
    checkout: await signJwt({ typ: RECEIPT_TYP, kid: signer.kid }, checkout, signer),
    payment: await signJwt({ typ: RECEIPT_TYP, kid: signer.kid }, payment, signer),
  };
}
