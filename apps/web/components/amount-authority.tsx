import { ShieldCheck, ShieldQuestion } from "lucide-react";

/** What decided a live purchase's amount, as the API reports it. */
export interface AmountAuthority {
  authority: "paypal_order" | "merchant_signed_cart" | "user_confirmed" | "checkout_page";
  via?: "own" | "partner" | "ucp";
  crossCheck: "agrees" | "unavailable";
}

/**
 * The line a live purchase shows for what decided its amount, and its detail.
 * @internal
 */
export function authorityLabel(
  a: AmountAuthority,
  store = "the store",
): {
  label: string;
  detail: string;
  confirmed: boolean;
} {
  switch (a.authority) {
    case "paypal_order":
      return {
        label: "Amount confirmed with PayPal",
        detail:
          a.via === "partner"
            ? `Read from PayPal's Orders API with ${store}'s permission`
            : "Read from PayPal's Orders API: this is Keelson's own PayPal order",
        confirmed: true,
      };
    case "merchant_signed_cart":
      return {
        label: "Amount signed by the store",
        detail: `${store} signed this cart; PayPal's checkout showed the same total`,
        confirmed: true,
      };
    case "user_confirmed":
      return {
        label: "Amount you confirmed",
        detail: "You confirmed it with your passkey on PayPal's checkout",
        confirmed: true,
      };
    case "checkout_page":
      return {
        label: "Amount not confirmed",
        detail: "Read from PayPal's checkout page only",
        confirmed: false,
      };
  }
}

/** One line: who decided the amount the agent paid on PayPal's checkout. */
export function AmountAuthorityLine({ a, store }: { a: AmountAuthority; store?: string }) {
  const { label, detail, confirmed } = authorityLabel(a, store);
  const Icon = confirmed ? ShieldCheck : ShieldQuestion;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
      <Icon
        className={confirmed ? "size-4 text-ok" : "size-4 text-muted-foreground"}
        aria-hidden="true"
      />
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">{detail}</span>
    </p>
  );
}
