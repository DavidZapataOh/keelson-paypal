import {
  createPayPal,
  fromSdkError,
  type PayPal,
  type PayPalEnv,
  PayPalError,
  paypalConfig,
  TokenCache,
} from "@keelson/paypal";
import type { Context } from "hono";
import { problem } from "./problem.ts";

export interface PayPalDeps {
  paypal: PayPal;
  /** The `custom_id` environment letter. */
  env: "s" | "p";
  /** Public by design: the JS SDK authenticates with the client ID alone. */
  clientId: string;
  environment: PayPalEnv;
  /** The payer id of the account the credentials belong to; Keelson captures only its holds. */
  merchantId: string;
}

export interface PayPalEnvVars {
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PAYPAL_ENV: PayPalEnv;
  PAYPAL_MERCHANT_ID: string;
}

export function createPayPalDeps(env: PayPalEnvVars): PayPalDeps {
  const cfg = paypalConfig({ ...env });
  return {
    paypal: createPayPal(cfg, new TokenCache(cfg)),
    env: cfg.env === "production" ? "p" : "s",
    clientId: cfg.clientId,
    environment: cfg.env,
    merchantId: env.PAYPAL_MERCHANT_ID,
  };
}

/** PayPal did not answer, timed out or failed on its side. */
class PayPalUnavailableError extends Error {
  constructor(cause: unknown) {
    super("PayPal is unavailable", { cause });
    this.name = "PayPalUnavailableError";
  }
}

/**
 * Awaits an SDK call. Throws `PayPalError` when PayPal refused the request and
 * `PayPalUnavailableError` for 5xx answers, timeouts and network failures.
 */
export async function call<T>(request: Promise<{ result: T }>): Promise<T> {
  try {
    return (await request).result;
  } catch (e) {
    const err = fromSdkError(e);
    if (err instanceof PayPalError && err.status < 500) throw err;
    throw new PayPalUnavailableError(err);
  }
}

/** The problem for a failed PayPal call, or `undefined` when `err` is not one. */
export function paypalProblem(c: Context, err: unknown) {
  if (err instanceof PayPalUnavailableError) {
    return problem(c, 503, "paypal-unavailable", "PayPal unavailable", "PayPal did not answer.");
  }
  if (err instanceof PayPalError) {
    const issue = err.details[0]?.issue ?? err.name;
    return problem(c, 422, "paypal-refused", "PayPal refused", err.message, {
      issue,
      ...(err.debugId === undefined ? {} : { debugId: err.debugId }),
    });
  }
  return undefined;
}
