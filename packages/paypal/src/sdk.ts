import {
  Client,
  Environment,
  OrdersController,
  PaymentsController,
  TransactionSearchController,
  VaultController,
} from "@paypal/paypal-server-sdk";
import type { PayPalConfig } from "./config.ts";
import { fromSdkError, isTokenRefused } from "./errors.ts";
import { createRestClient, type PayPalFetch, REQUEST_TIMEOUT_MS } from "./rest.ts";
import type { TokenCache } from "./token.ts";

export interface PayPal {
  orders: OrdersController;
  payments: PaymentsController;
  transactions: TransactionSearchController;
  vault: VaultController;
  fetch: PayPalFetch;
}

type Controllers = Omit<PayPal, "fetch"> & {
  /** The token this client's calls carry: the SDK keeps the last one it was given. */
  token: () => string;
};

/**
 * The SDK's controllers, made again with a new token when PayPal refuses the one in use: the SDK
 * keeps a token until it expires, so a revoked token, or one issued before the app gained a
 * scope, would otherwise fail every call until then. Each call is retried once.
 */
export function createPayPal(cfg: PayPalConfig, tokens: TokenCache): PayPal {
  const make = (): Controllers => {
    const provide = tokens.sdkProvider();
    let token = "";
    const client = new Client({
      environment: cfg.env === "production" ? Environment.Production : Environment.Sandbox,
      timeout: REQUEST_TIMEOUT_MS,
      clientCredentialsAuthCredentials: {
        oAuthClientId: cfg.clientId,
        oAuthClientSecret: cfg.clientSecret,
        oAuthTokenProvider: async (last) => {
          const next = await provide(last);
          token = next.accessToken;
          return next;
        },
      },
    });
    return {
      orders: new OrdersController(client),
      payments: new PaymentsController(client),
      transactions: new TransactionSearchController(client),
      vault: new VaultController(client),
      token: () => token,
    };
  };
  let current = make();

  const retrying = <K extends keyof Omit<Controllers, "token">>(key: K): Controllers[K] =>
    new Proxy({} as Controllers[K], {
      get(_, prop) {
        const value: unknown = Reflect.get(current[key], prop);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          const made = current;
          try {
            return await value.apply(made[key], args);
          } catch (e) {
            if (!isTokenRefused(fromSdkError(e))) throw e;
            tokens.invalidate(made.token());
            if (current === made) current = make();
            const again = Reflect.get(current[key], prop) as (...a: unknown[]) => unknown;
            return await again.apply(current[key], args);
          }
        };
      },
    });

  return {
    orders: retrying("orders"),
    payments: retrying("payments"),
    transactions: retrying("transactions"),
    vault: retrying("vault"),
    fetch: createRestClient(cfg, tokens),
  };
}
