import type { Disclosed, Mandate } from "@keelson/mandate";
import { base64url } from "jose";
import type { PaymentInstrument } from "./ap2.ts";
import type { Merchant, PurchaseFacts } from "./facts.ts";
import { type Disclosure, disclose, type EcPublicJwk, hashB64u, ref, type Signer } from "./jose.ts";
import { normalize } from "./normalize.ts";

/**
 * Mastercard Verifiable Intent v0.1 (github.com/agent-intent/verifiable-intent,
 * `spec/credential-format.md`): the L1 credential, the Autonomous L2 the user delegates with,
 * and the L3a/L3b the agent closes it with.
 */

/** `vct` of the L1 credential Keelson issues: a PayPal account holder, not a card. */
export const VI_L1_VCT = "https://keelson.finance/credentials/paypal/v1";

/**
 * JSON as Python's `json.dumps(v, separators=(",", ":"))` writes it, ASCII only: the VI reference
 * verifier re-encodes the header and payload that way before it checks a signature.
 */
const asciiJson = (v: unknown): string =>
  JSON.stringify(v).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

async function sign(
  header: Record<string, unknown>,
  payload: unknown,
  signer: Signer,
): Promise<string> {
  const input = `${base64url.encode(asciiJson({ ...header, alg: "ES256" }))}.${base64url.encode(asciiJson(payload))}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signer.key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64url.encode(new Uint8Array(signature))}`;
}

/** `<jwt>~<d1>~…~`, VI's `build_selective_presentation`. */
const present = (jwt: string, disclosures: readonly string[]): string =>
  `${[jwt, ...disclosures].join("~")}~`;

/** A VI credential chain for one mandate, with each party's view of L2. */
export interface ViChain {
  l1: string;
  l2: string;
  /** L2 as the network sees it: the payment mandate and the payee. */
  l2Payment: string;
  /** L2 as the merchant sees it: the checkout mandate and the items. */
  l2Checkout: string;
  notes: string[];
  /** The disclosures L3a and L3b bind to, by role. */
  refs: { payment: string; payee: string; checkout: string; items: string[] };
}

/**
 * Issues L1 and the Autonomous L2 of a Keelson mandate. `signer` is both the L1 issuer and the
 * "authorized system holding the user's private key" that signs L2 (credential-format §4.1):
 * Keelson signs only after the user's passkey assertion over the mandate, whose `M` L1 and L2
 * carry as `keelson.mandate_hash`.
 */
export async function issueViL2(
  m: Disclosed<Mandate>,
  signer: Signer,
  opts: {
    mandateHash: string;
    iss: string;
    instrument: PaymentInstrument;
    payee?: string | undefined;
  },
): Promise<ViChain> {
  const cnf = m.agent?.cnf?.jwk as EcPublicJwk | undefined;
  if (!cnf || m.iat === undefined || m.exp === undefined || !m.user?.sub || !m.nonce) {
    throw new RangeError("the mandate's user, agent key and lifetime are undisclosed");
  }
  const n = normalize(m);
  const email = m.user.app_login_id ? [disclose(m.user.app_login_id, "email")] : [];
  const l1Jwt = await sign(
    { typ: "sd+jwt", kid: signer.kid },
    {
      iss: opts.iss,
      sub: m.user.sub,
      iat: m.iat,
      exp: m.exp,
      vct: VI_L1_VCT,
      cnf: { jwk: signer.jwk },
      keelson: { mandate_hash: opts.mandateHash },
      _sd_alg: "sha-256",
      _sd: email.map((d) => d.digest),
    },
    signer,
  );
  const l1 = present(
    l1Jwt,
    email.map((d) => d.encoded),
  );

  const merchants = n.merchants.map((x) => ({ value: x, d: disclose(x) }));
  const payees = n.payees.map((x) => ({ value: x, d: disclose(x) }));
  const items = n.lines.flatMap((l) => l.acceptable.map((a) => ({ value: a, d: disclose(a) })));
  const agentJwk = { ...cnf, kid: cnf.kid ?? "agent" };
  const checkout = disclose({
    vct: "mandate.checkout.open.1",
    cnf: { jwk: agentJwk },
    constraints: [
      { type: "mandate.checkout.allowed_merchants", allowed: merchants.map((x) => ref(x.d)) },
      {
        type: "mandate.checkout.line_items",
        items: n.lines.map((l) => ({
          id: l.id,
          acceptable_items: l.acceptable.map((a) =>
            ref((items.find((x) => x.value === a) as { d: Disclosure }).d),
          ),
          quantity: l.quantity,
        })),
        match_mode: "exact",
      },
    ],
  });
  const payment = disclose({
    vct: "mandate.payment.open.1",
    cnf: { jwk: agentJwk },
    payment_instrument: opts.instrument,
    ...(m.risk_data
      ? { risk_data: { device_id: m.risk_data.device_fp, ip_address: m.risk_data.ip } }
      : {}),
    constraints: [
      ...(n.maxAmount !== undefined
        ? [{ type: "mandate.payment.amount_range", currency: n.currency, max: n.maxAmount }]
        : []),
      ...(n.budget !== undefined
        ? [{ type: "mandate.payment.budget", currency: n.currency, max: n.budget }]
        : []),
      ...(payees.length > 0
        ? [{ type: "mandate.payment.allowed_payees", allowed: payees.map((x) => ref(x.d)) }]
        : []),
      { type: "mandate.payment.reference", conditional_transaction_id: checkout.digest },
    ],
  });
  const all = [
    ...merchants.map((x) => x.d),
    ...payees.map((x) => x.d),
    ...items.map((x) => x.d),
    checkout,
    payment,
  ];
  const l2Jwt = await sign(
    { typ: "kb-sd-jwt+kb", kid: signer.kid },
    {
      nonce: m.nonce,
      aud: `${m.agent?.operator?.agent_registry}/${m.agent?.operator?.agent_id}`,
      iat: m.iat,
      sd_hash: hashB64u(l1),
      delegate_payload: [ref(checkout), ref(payment)],
      _sd_alg: "sha-256",
      _sd: all.map((d) => d.digest),
      iss: opts.iss,
      exp: m.exp,
    },
    signer,
  );
  const payee = (payees.find((x) => x.value.id === opts.payee) ?? payees[0] ?? merchants[0])?.d;
  if (!payee) throw new RangeError("the mandate discloses no merchant");
  const itemRefs = items.map((x) => x.d.encoded);
  return {
    l1,
    l2: present(
      l2Jwt,
      all.map((d) => d.encoded),
    ),
    l2Payment: present(l2Jwt, [payment.encoded, payee.encoded]),
    l2Checkout: present(l2Jwt, [checkout.encoded, ...itemRefs]),
    notes: n.notes,
    refs: {
      payment: payment.encoded,
      payee: payee.encoded,
      checkout: checkout.encoded,
      items: itemRefs,
    },
  };
}

/** L3a (payment, for the network) and L3b (checkout, for the merchant) of one purchase. */
export interface ViL3 {
  l3Payment: string;
  l3Checkout: string;
}

/**
 * Closes the L2 for one purchase with the agent's key (credential-format §5): L3a carries the
 * final payment and payee, `aud` the network; L3b the merchant's checkout JWT, `aud` the merchant.
 * Each `sd_hash` covers L2 as that recipient sees it.
 */
export async function closeVi(
  chain: ViChain,
  f: PurchaseFacts,
  checkoutJwtValue: string,
  agent: Signer,
  opts: { nonce: string; iat: number; networkAud: string; merchantAud: string; iss?: string },
): Promise<ViL3> {
  const checkoutHash = hashB64u(checkoutJwtValue);
  const payee = JSON.parse(new TextDecoder().decode(base64url.decode(chain.refs.payee))).at(
    -1,
  ) as Merchant;
  const merchant = disclose(payee);
  const payment = disclose({
    vct: "mandate.payment.1",
    transaction_id: checkoutHash,
    payee,
    payment_amount: { currency: f.currency, amount: f.totalMinor },
    payment_instrument: (
      JSON.parse(new TextDecoder().decode(base64url.decode(chain.refs.payment))).at(-1) as {
        payment_instrument: PaymentInstrument;
      }
    ).payment_instrument,
  });
  const exp = opts.iat + 300;
  const base = {
    nonce: opts.nonce,
    iat: opts.iat,
    ...(opts.iss ? { iss: opts.iss } : {}),
    exp,
    _sd_alg: "sha-256",
  };
  const l2Base = chain.l2.slice(0, chain.l2.indexOf("~"));
  const l3a = await sign(
    { typ: "kb-sd-jwt", kid: agent.kid },
    {
      ...base,
      aud: opts.networkAud,
      sd_hash: hashB64u(present(l2Base, [chain.refs.payment, chain.refs.payee])),
      delegate_payload: [ref(merchant), ref(payment)],
    },
    agent,
  );
  const checkout = disclose({
    vct: "mandate.checkout.1",
    checkout_jwt: checkoutJwtValue,
    checkout_hash: checkoutHash,
  });
  const l3b = await sign(
    { typ: "kb-sd-jwt", kid: agent.kid },
    {
      ...base,
      aud: opts.merchantAud,
      sd_hash: hashB64u(present(l2Base, [chain.refs.checkout, ...chain.refs.items])),
      delegate_payload: [ref(checkout)],
    },
    agent,
  );
  return {
    l3Payment: present(l3a, [merchant.encoded, payment.encoded]),
    l3Checkout: present(l3b, [checkout.encoded]),
  };
}
