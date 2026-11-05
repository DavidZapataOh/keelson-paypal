import {
  Client,
  Environment,
  OrdersController,
  PaymentsController,
  TransactionSearchController,
  VaultController,
} from "@paypal/paypal-server-sdk";
import type { PayPalConfig } from "./config.ts";
import { createRestClient, type PayPalFetch, REQUEST_TIMEOUT_MS } from "./rest.ts";
import type { TokenCache } from "./token.ts";

export interface PayPal {
  orders: OrdersController;
  payments: PaymentsController;
  transactions: TransactionSearchController;
  vault: VaultController;
  fetch: PayPalFetch;
}

export function createPayPal(cfg: PayPalConfig, tokens: TokenCache): PayPal {
  const client = new Client({
    environment: cfg.env === "production" ? Environment.Production : Environment.Sandbox,
    timeout: REQUEST_TIMEOUT_MS,
    clientCredentialsAuthCredentials: {
      oAuthClientId: cfg.clientId,
      oAuthClientSecret: cfg.clientSecret,
      oAuthTokenProvider: tokens.sdkProvider(),
    },
  });
  return {
    orders: new OrdersController(client),
    payments: new PaymentsController(client),
    transactions: new TransactionSearchController(client),
    vault: new VaultController(client),
    fetch: createRestClient(cfg, tokens),
  };
}
