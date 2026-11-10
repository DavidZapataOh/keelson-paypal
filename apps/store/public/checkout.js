// PayPal JavaScript SDK v6 one-time payment: the store creates and captures the order server-side.
const root = document.querySelector("[data-checkout]");
const button = root.querySelector("paypal-button");
const status = root.querySelector("[role=status]");
const size = root.querySelector("#size");

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail ?? data.title);
  return data;
}

const fail = (error) => {
  status.textContent = `Payment failed: ${error?.message ?? error}. Please try again.`;
};

try {
  const sdk = await window.paypal.createInstance({
    clientId: root.dataset.clientId,
    components: ["paypal-payments"],
    pageType: "checkout",
  });
  const methods = await sdk.findEligibleMethods({ currencyCode: "USD" });
  if (!methods.isEligible("paypal")) {
    status.textContent = "PayPal is not available in this browser.";
  } else {
    const session = sdk.createPayPalOneTimePaymentSession({
      async onApprove({ orderId }) {
        status.textContent = "Completing your payment…";
        await post(`/api/orders/${encodeURIComponent(orderId)}/capture`);
        location.assign(`/orders/${encodeURIComponent(orderId)}`);
      },
      onCancel() {
        status.textContent = "Payment cancelled. You have not been charged.";
      },
      onError: fail,
    });
    button.addEventListener("click", () => {
      status.textContent = "";
      // The order promise goes to start() unawaited so the popup opens on the click.
      const order = post("/api/orders", {
        lines: [{ handle: root.dataset.handle, size: size.value, qty: 1 }],
      }).then(({ id }) => ({ orderId: id }));
      session.start({ presentationMode: "auto" }, order).catch(fail);
    });
    button.removeAttribute("hidden");
  }
} catch (error) {
  fail(error);
}
