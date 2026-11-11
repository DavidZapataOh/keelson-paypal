import { CURRENCIES, type CurrencyCode } from "@keelson/core";
import { ANY_ITEM, ANY_MERCHANT } from "@keelson/mandate";
import type { PurchaseFacts } from "./facts.ts";

type Constraint = Record<string, unknown> & { type: string };

/** A mandate's constraints as AP2 and Verifiable Intent state them. */
export interface StandardConstraints {
  checkout: Constraint[];
  /** Without `payment.reference`, which binds to the issued checkout mandate. */
  payment: Constraint[];
  /**
   * The constraints only Keelson defines, verbatim. AP2 and VI fail any constraint type they do
   * not know, so these travel in the `keelson` claim instead.
   */
  keelsonOnly: Constraint[];
  /**
   * Constraint types stated more narrowly than the mandate: a wildcard line the enclaves allowed
   * is stated as the items they checked. The mandate's own constraint rides in `keelsonOnly`.
   */
  refined: string[];
}

const merchantOf = (m: { id?: string; name?: string; website?: string | undefined }) => ({
  id: m.id as string,
  name: m.name as string,
  ...(m.website ? { website: m.website } : {}),
});

type NamedMerchant = { id?: string; name?: string; website?: string; paypal_merchant_id?: string };

/**
 * A PayPal payee as a merchant: the allowed merchant with its PayPal merchant id, or the only
 * allowed merchant, else the bare id.
 */
function payeeOf(merchants: NamedMerchant[], paypalId: string) {
  const of =
    merchants.find((x) => x.paypal_merchant_id === paypalId) ??
    (merchants.length === 1 ? merchants[0] : undefined);
  return {
    id: paypalId,
    name: of?.name ?? paypalId,
    ...(of?.website ? { website: of.website } : {}),
  };
}

/**
 * Maps the disclosed constraints of a purchase's mandate to AP2's constraint types. AP2 has no
 * wildcard: a wildcard merchant is no AP2 constraint, and a wildcard line of an allowed purchase is
 * stated as the items the enclaves checked against it.
 */
export function ap2Constraints(f: PurchaseFacts): StandardConstraints {
  const m = f.mandate;
  const out: StandardConstraints = { checkout: [], payment: [], keelsonOnly: [], refined: [] };
  const merchants: NamedMerchant[] = [];
  for (const c of m.checkout?.constraints ?? []) {
    if (!c?.type) continue;
    if (c.type === "checkout.allowed_merchants") {
      if ((c.allowed ?? []).some((x) => x?.id === ANY_MERCHANT)) {
        out.keelsonOnly.push(c as Constraint);
        continue;
      }
      const allowed = (c.allowed ?? []).filter((x) => x?.id && x.name);
      merchants.push(...(allowed as typeof merchants));
      out.checkout.push({ type: c.type, allowed: allowed.map((x) => merchantOf(x ?? {})) });
    } else if (c.type === "checkout.line_items") {
      const items = c.items ?? [];
      const wildcard = items.some((l) =>
        (l?.acceptable_items ?? []).some((a) => a?.id === ANY_ITEM),
      );
      const checked = f.decision === "allow" && items.length === 1 && f.lines?.length;
      if (wildcard) out.keelsonOnly.push(c as Constraint);
      if (wildcard && checked) out.refined.push(c.type);
      out.checkout.push({
        type: c.type,
        items: items.map((line) => ({
          id: line?.id,
          acceptable_items:
            wildcard && checked
              ? (f.lines ?? []).map((l) => ({ id: l.sku, title: l.title }))
              : (line?.acceptable_items ?? []).map((a) => ({
                  id: a?.id,
                  title: a?.title ?? a?.id,
                })),
          quantity: line?.quantity,
        })),
      });
    } else {
      out.keelsonOnly.push(c as Constraint);
    }
  }
  const exponent = CURRENCIES[m.payment?.currency as CurrencyCode]?.exponent ?? 2;
  let budget = false;
  for (const c of m.payment?.constraints ?? []) {
    if (!c?.type) continue;
    switch (c.type) {
      case "payment.amount_range":
        out.payment.push({ type: c.type, currency: c.currency, max: c.max });
        break;
      case "payment.budget":
        budget = true;
        out.payment.push({
          type: c.type,
          currency: c.currency,
          max: Number(c.max) / 10 ** exponent,
        });
        break;
      case "payment.execution_date":
        out.payment.push({ type: c.type, not_after: c.not_after });
        break;
      case "payment.allowed_payees":
        out.payment.push({
          type: c.type,
          allowed: (c.allowed ?? []).map((p) => {
            const { id, name } = payeeOf(merchants, p?.paypal_merchant_id as string);
            return { id, name };
          }),
        });
        break;
      default:
        out.keelsonOnly.push(c as Constraint);
    }
  }
  if (budget) out.payment.push({ type: "payment.agent_recurrence", frequency: "ON_DEMAND" });
  return out;
}

/**
 * Maps the disclosed constraints of a purchase's mandate to Verifiable Intent's `mandate.*` types,
 * with AP2's wildcard rules. Amounts and budgets stay in minor units. Payees are stated as
 * merchants. VI has no execution date, so it travels verbatim with the Keelson-only constraints.
 */
export function viConstraints(f: PurchaseFacts): StandardConstraints {
  const ap2 = ap2Constraints(f);
  const merchants = (f.mandate.checkout?.constraints ?? []).flatMap((c) =>
    c?.type === "checkout.allowed_merchants"
      ? ((c.allowed ?? []).filter(
          (x) => x?.id && x.id !== ANY_MERCHANT && x.name,
        ) as NamedMerchant[])
      : [],
  );
  const out: StandardConstraints = {
    checkout: ap2.checkout.map((c) => ({ ...c, type: `mandate.${c.type}` })),
    payment: [],
    keelsonOnly: ap2.keelsonOnly.filter((c) => !c.type.startsWith("payment.")),
    refined: ap2.refined,
  };
  for (const c of f.mandate.payment?.constraints ?? []) {
    if (!c?.type) continue;
    switch (c.type) {
      case "payment.amount_range":
      case "payment.budget":
        out.payment.push({ type: `mandate.${c.type}`, currency: c.currency, max: c.max });
        break;
      case "payment.allowed_payees":
        out.payment.push({
          type: "mandate.payment.allowed_payees",
          allowed: (c.allowed ?? []).map((p) =>
            payeeOf(merchants, p?.paypal_merchant_id as string),
          ),
        });
        break;
      default:
        out.keelsonOnly.push(c as Constraint);
    }
  }
  return out;
}
