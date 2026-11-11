import { CURRENCIES, type CurrencyCode } from "@keelson/core";
import type { Disclosed, Mandate } from "@keelson/mandate";

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
}

const merchantOf = (m: { id?: string; name?: string; website?: string | undefined }) => ({
  id: m.id as string,
  name: m.name as string,
  ...(m.website ? { website: m.website } : {}),
});

/** Maps the disclosed constraints of a mandate to AP2's constraint types. */
export function ap2Constraints(m: Disclosed<Mandate>): StandardConstraints {
  const out: StandardConstraints = { checkout: [], payment: [], keelsonOnly: [] };
  const merchants: { id?: string; name?: string; website?: string; paypal_merchant_id?: string }[] =
    [];
  for (const c of m.checkout?.constraints ?? []) {
    if (!c?.type) continue;
    if (c.type === "checkout.allowed_merchants") {
      const allowed = (c.allowed ?? []).filter((x) => x?.id && x.name);
      merchants.push(...(allowed as typeof merchants));
      out.checkout.push({ type: c.type, allowed: allowed.map((x) => merchantOf(x ?? {})) });
    } else if (c.type === "checkout.line_items") {
      out.checkout.push({
        type: c.type,
        items: (c.items ?? []).map((line) => ({
          id: line?.id,
          acceptable_items: (line?.acceptable_items ?? []).map((a) => ({
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
            const of =
              merchants.find((x) => x.paypal_merchant_id === p?.paypal_merchant_id) ??
              (merchants.length === 1 ? merchants[0] : undefined);
            return {
              id: p?.paypal_merchant_id as string,
              name: of?.name ?? (p?.paypal_merchant_id as string),
            };
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
