import { toPayPalValue } from "@keelson/core";
import { fromSdkError, type PayPal, PayPalError } from "@keelson/paypal";
import {
  CheckoutPaymentIntent,
  ItemCategory,
  type Order,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
} from "@paypal/paypal-server-sdk";
import { BRAND, type Quote } from "./catalog.ts";

/** The `reference_id` of the store's purchase units; the store reads and captures only these. @internal */
export const STORE_REFERENCE = "runfast-store";

/** PayPal order ids are short upper-case alphanumerics. */
const ORDER_ID = /^[A-Z0-9]{8,36}$/;

async function call<T>(p: Promise<{ result: T }>): Promise<T> {
  try {
    return (await p).result;
  } catch (e) {
    throw fromSdkError(e);
  }
}

/** Creates the CAPTURE order for a quote, priced and itemized from the catalog. */
export function createOrder(paypal: PayPal, q: Quote, origin: string): Promise<Order> {
  const currencyCode = q.total.currency;
  const value = toPayPalValue(q.total);
  return call(
    paypal.orders.createOrder({
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [
          {
            referenceId: STORE_REFERENCE,
            description: `${BRAND} order`,
            amount: { currencyCode, value, breakdown: { itemTotal: { currencyCode, value } } },
            items: q.lines.map(({ product: p, size, qty }, k) => ({
              name: `${p.title}, size ${size}`,
              sku: q.cart.lines[k]?.sku as string,
              url: `${origin}/products/${p.handle}`,
              quantity: String(qty),
              category: ItemCategory.PhysicalGoods,
              unitAmount: {
                currencyCode,
                value: toPayPalValue({ currency: currencyCode, minor: BigInt(p.priceMinor) }),
              },
            })),
          },
        ],
        paymentSource: {
          paypal: {
            experienceContext: {
              brandName: BRAND,
              userAction: PaypalExperienceUserAction.PayNow,
              shippingPreference: PaypalWalletContextShippingPreference.GetFromFile,
              returnUrl: `${origin}/checkout/return`,
              cancelUrl: `${origin}/`,
              locale: "en-US",
            },
          },
        },
      },
    }),
  );
}

/** The order if it exists and the store created it, else `null`. */
export async function storeOrder(paypal: PayPal, id: string): Promise<Order | null> {
  if (!ORDER_ID.test(id)) return null;
  try {
    const order = await call(paypal.orders.getOrder({ id }));
    return order.purchaseUnits?.[0]?.referenceId === STORE_REFERENCE ? order : null;
  } catch (e) {
    if (e instanceof PayPalError && e.status === 404) return null;
    throw e;
  }
}

export type CaptureResult =
  | { kind: "captured"; order: Order }
  | { kind: "not-found" }
  | { kind: "not-approved" };

/** Captures one of the store's approved orders; an order already captured is returned as is. */
export async function captureOrder(paypal: PayPal, id: string): Promise<CaptureResult> {
  const order = await storeOrder(paypal, id);
  if (!order) return { kind: "not-found" };
  if (order.status === "COMPLETED") return { kind: "captured", order };
  try {
    return {
      kind: "captured",
      order: await call(
        paypal.orders.captureOrder({
          id,
          paypalRequestId: `capture-${id}`,
          prefer: "return=representation",
        }),
      ),
    };
  } catch (e) {
    if (e instanceof PayPalError && e.details.some((d) => d.issue === "ORDER_NOT_APPROVED")) {
      return { kind: "not-approved" };
    }
    throw e;
  }
}
