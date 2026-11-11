/**
 * Hold approval for the user app, on the PayPal JavaScript SDK v6 one-time payment session.
 *
 * ```ts
 * const status = await approveHold({
 *   api,
 *   container,
 *   currencyCode: "USD",
 *   ...mandateHold(api, mandateId),
 *   onCancel: () => showRetry(),
 * });
 * if (status === "ineligible") showUnavailable();
 * ```
 *
 * Keelson creates the `AUTHORIZE` order server-side; the SDK only presents it to the buyer, and
 * the approved order is authorized by Keelson.
 *
 * @module
 */
import { loadCoreSdkScript } from "@paypal/paypal-js/sdk-v6";

export interface ApproveHoldOptions {
  /** The API origin. Requests carry the session cookie. */
  api: string;
  /** Where the `<paypal-button>` is appended. */
  container: HTMLElement;
  /** The ISO 4217 code of the hold, for the eligibility check. */
  currencyCode: string;
  /**
   * Creates (or returns the pending) order of the hold. `approved` is true when the user's saved
   * PayPal already paid it, so PayPal has nothing to show.
   */
  createOrder: () => Promise<{ orderId: string; approved?: boolean }>;
  /** Authorizes the order the buyer approved. */
  authorize: (orderId: string) => Promise<void>;
  /** The buyer closed PayPal without approving; the same order is offered on the next click. */
  onCancel?: () => void;
  onError?: (error: unknown) => void;
}

interface PayPalClient {
  clientId: string;
  environment: "sandbox" | "production";
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { title?: string; detail?: string };
  if (!res.ok) {
    throw new Error(body.detail ?? body.title ?? `The API answered ${res.status}.`, {
      cause: body,
    });
  }
  return body;
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "idempotency-key": crypto.randomUUID(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return json<T>(res);
}

/**
 * Loads the SDK with the API's client ID and, when PayPal is eligible, appends a
 * `<paypal-button>` to `o.container` that starts the one-time payment session.
 */
export async function approveHold(o: ApproveHoldOptions): Promise<"ready" | "ineligible"> {
  const { clientId, environment } = await json<PayPalClient>(
    await fetch(`${o.api}/v1/paypal/client`, { credentials: "include" }),
  );
  const paypal = await loadCoreSdkScript({ environment });
  if (!paypal) throw new Error("The PayPal JavaScript SDK did not load.");
  const sdk = await paypal.createInstance({
    clientId,
    components: ["paypal-payments"],
    pageType: "checkout",
  });
  const methods = await sdk.findEligibleMethods({ currencyCode: o.currencyCode });
  if (!methods.isEligible("paypal")) return "ineligible";

  const fail = (error: unknown) => {
    if (!o.onError) throw error;
    o.onError(error);
  };
  const session = sdk.createPayPalOneTimePaymentSession({
    onApprove: ({ orderId }) => o.authorize(orderId).catch(fail),
    onCancel: () => o.onCancel?.(),
    onError: fail,
  });
  const button = document.createElement("paypal-button");
  button.addEventListener("click", () => {
    session.start({ presentationMode: "auto" }, o.createOrder()).catch(fail);
  });
  o.container.append(button);
  return "ready";
}

/** The order and authorization calls of a mandate's hold. */
export function mandateHold(
  api: string,
  mandateId: string,
): Pick<ApproveHoldOptions, "createOrder" | "authorize"> {
  const base = `${api}/v1/mandates/${encodeURIComponent(mandateId)}/hold`;
  return {
    createOrder: async () => {
      const { orderId, approved } = await post<{ orderId: string; approved?: boolean }>(base);
      return { orderId, approved: approved === true };
    },
    authorize: async (orderId) => {
      await post(`${base}/authorize`, { orderId });
    },
  };
}

/**
 * Holds a mandate's budget with the user's saved PayPal, with no PayPal window: `"active"` once
 * it is authorized, or `"approve"` when PayPal still needs the buyer, which the PayPal button of
 * {@link approveHold} then offers with the same order.
 */
export async function holdWithSavedPayPal(
  api: string,
  mandateId: string,
): Promise<"active" | "approve"> {
  const calls = mandateHold(api, mandateId);
  const { orderId, approved } = await calls.createOrder();
  if (!approved) return "approve";
  await calls.authorize(orderId);
  return "active";
}

/**
 * The approval of one purchase hold of a multi-merchant mandate. The agent creates its order; the
 * app learns `orderId` from the `mandate.purchase_hold` event and the buyer approves that order.
 */
export function purchaseHold(
  api: string,
  mandateId: string,
  requestId: string,
  orderId: string,
): Pick<ApproveHoldOptions, "createOrder" | "authorize"> {
  const base = `${api}/v1/mandates/${encodeURIComponent(mandateId)}/holds/${encodeURIComponent(requestId)}`;
  return {
    createOrder: () => Promise.resolve({ orderId }),
    authorize: async (approved) => {
      await post(`${base}/authorize`, { orderId: approved });
    },
  };
}
