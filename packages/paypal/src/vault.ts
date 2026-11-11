import {
  ExperienceContextShippingPreference,
  PaymentInitiator,
  type PaymentTokenRequest,
  type PaymentTokenResponse,
  PaypalPaymentTokenCustomerType,
  PaypalPaymentTokenUsageType,
  type SetupTokenRequest,
  UsagePattern,
  VaultTokenRequestType,
  VaultUserAction,
} from "@paypal/paypal-server-sdk";
import type { HoldOrder } from "./hold.ts";

/** What PayPal shows the buyer when they save PayPal, and later on paypal.com. */
export const WALLET_DESCRIPTION = "Keelson holds your agent's budget, only under mandates you sign";

/**
 * A mandate is the agreed logic: amounts and dates vary, and each hold is taken before the agent
 * buys.
 */
const USAGE_PATTERN = UsagePattern.UnscheduledPrepaid;

/** PayPal answered with something that is not a usable saved PayPal. */
export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

/** The setup token the buyer approves to save PayPal for Keelson's holds, one token per user. */
export function walletSetupTokenRequest(o: {
  returnUrl: string;
  cancelUrl: string;
  customerId?: string;
}): SetupTokenRequest {
  return {
    ...(o.customerId === undefined ? {} : { customer: { id: o.customerId } }),
    paymentSource: {
      paypal: {
        description: WALLET_DESCRIPTION,
        usagePattern: USAGE_PATTERN,
        usageType: PaypalPaymentTokenUsageType.Merchant,
        customerType: PaypalPaymentTokenCustomerType.Consumer,
        permitMultiplePaymentTokens: false,
        experienceContext: {
          returnUrl: o.returnUrl,
          cancelUrl: o.cancelUrl,
          shippingPreference: ExperienceContextShippingPreference.NoShipping,
          userAction: VaultUserAction.SetupNow,
          locale: "en-US",
        },
      },
    },
  };
}

/** Exchanges an approved setup token for the payment token. */
export function walletPaymentTokenRequest(setupTokenId: string): PaymentTokenRequest {
  return {
    paymentSource: { token: { id: setupTokenId, type: VaultTokenRequestType.SetupToken } },
  };
}

/**
 * The same hold paid with the saved PayPal: PayPal authorizes it when it is created, with no
 * buyer present. Agent holds are merchant-initiated.
 */
export function vaultedHoldOrder(order: HoldOrder, vaultId: string): HoldOrder {
  return {
    paypalRequestId: order.paypalRequestId,
    body: {
      ...order.body,
      paymentSource: {
        paypal: {
          vaultId,
          storedCredential: {
            paymentInitiator: PaymentInitiator.Merchant,
            usagePattern: USAGE_PATTERN,
          },
        },
      },
    },
  };
}

export interface SavedWallet {
  vaultId: string;
  customerId: string;
  email?: string;
}

export function savedWallet(token: PaymentTokenResponse): SavedWallet {
  const vaultId = token.id;
  const customerId = token.customer?.id;
  if (!vaultId) throw new VaultError("the payment token has no id");
  if (!customerId) throw new VaultError("the payment token has no customer");
  const email = token.paymentSource?.paypal?.emailAddress;
  return { vaultId, customerId, ...(email ? { email } : {}) };
}
