import { pack, uint8ArrayToBase64Url } from "@sd-jwt/core";
import { compactVerify, decodeProtectedHeader, importJWK, SignJWT } from "jose";
import { transform } from "./bindings.ts";
import { ap2Constraints } from "./constraints.ts";
import { type PurchaseFacts, type StatementFacts, statementFacts } from "./facts.ts";
import { b64uSha256, jwtPayload, sdHash, sha256Hasher } from "./jose.ts";
import type { AgentSigner, EcPublicJwk, ExportSigner } from "./signer.ts";
import type { AlibiRef } from "./statement.ts";
import type { CheckId, ExportReport } from "./verify.ts";

/** The export profiles of AP2's issuer-signed artifacts. */
export const AP2_OPEN = "ap2.open/1";
export const AP2_CHECKOUT_JWT = "ap2.checkout_jwt/1";
export const AP2_CHECKOUT_RECEIPT = "ap2.checkout_receipt/1";
export const AP2_PAYMENT_RECEIPT = "ap2.payment_receipt/1";
const JWT = "JWT";
/** `typ` of a terminal delegation hop (AP2 `kb_sd_jwt.TYP_TERMINAL`). */
const KB_SD_JWT = "kb+sd-jwt";
const ISSUER = "https://keelson.finance";
/** The JWS `typ` of a root SD-JWT. */
const SD_JWT = "sd+jwt";

const VERIFY_ORIGIN = "https://verify.keelson.finance";

const salt = () => uint8ArrayToBase64Url(crypto.getRandomValues(new Uint8Array(16)));

/** The `keelson` claim of every issuer-signed export payload. */
export function keelsonClaim(f: PurchaseFacts, ref: AlibiRef, profile: string) {
  return {
    profile,
    statement: ref.statement,
    facts: statementFacts(f),
    alibi_id: f.alibiId,
    env: f.env,
    verify_url: `${VERIFY_ORIGIN}/a/${f.alibiId}`,
  };
}

/**
 * A root SD-JWT as AP2's SDK issues it: the mandate is the one disclosed element of
 * `delegate_payload`; `extra` claims ride beside it, signed.
 */
async function rootSdJwt(
  mandate: Record<string, unknown>,
  extra: Record<string, unknown>,
  issuer: ExportSigner,
  statement: string,
): Promise<string> {
  const { packedClaims, disclosures } = await pack(
    { delegate_payload: [mandate] },
    { delegate_payload: { _sd: [0] } },
    { hasher: sha256Hasher, alg: "sha-256" },
    salt,
  );
  const jwt = await issuer.sign(
    SD_JWT,
    { ...packedClaims, _sd_alg: "sha-256", ...extra },
    statement,
  );
  return `${jwt}~${disclosures.map((d) => `${d.encode()}~`).join("")}`;
}

/** The issuer-signed payload of a root SD-JWT. */
export const openPayload = (token: string): Record<string, unknown> => jwtPayload(token);

/**
 * The purchase's mandate as AP2 v0.2 open checkout and payment mandates, signed in the issuer
 * slot and delegated to the agent's `cnf` key. The payment mandate's `payment.reference` is the
 * `sd_hash` of the open checkout mandate.
 */
export async function issueAp2Open(
  f: PurchaseFacts,
  ref: AlibiRef,
  issuer: ExportSigner,
): Promise<{ checkout: string; payment: string }> {
  const m = f.mandate;
  const c = ap2Constraints(m);
  const extra = {
    keelson: {
      ...keelsonClaim(f, ref, AP2_OPEN),
      l2: f.l2,
      user_auth: f.userAuth,
      constraints: c.keelsonOnly,
    },
  };
  const common = { cnf: m.agent?.cnf, iat: m.iat, exp: m.exp };
  const checkout = await rootSdJwt(
    { vct: "mandate.checkout.open.1", constraints: c.checkout, ...common },
    extra,
    issuer,
    ref.statement,
  );
  const payment = await rootSdJwt(
    {
      vct: "mandate.payment.open.1",
      constraints: [
        ...c.payment,
        { type: "payment.reference", conditional_transaction_id: sdHash(checkout) },
      ],
      ...common,
    },
    extra,
    issuer,
    ref.statement,
  );
  return { checkout, payment };
}

/** A purchase as AP2 v0.2 states it: open and closed mandates, the checkout and the receipts. */
export interface Ap2Export {
  type: "keelson.ap2/1";
  alibi: AlibiRef;
  checkout: { open: string; checkout_jwt: string; closed?: string; receipt?: string };
  payment: { open: string; closed?: string; receipt?: string };
  /** The closed mandates' payloads, when the exporter does not hold the agent's key. */
  pending_close?: { checkout: Record<string, unknown>; payment: Record<string, unknown> };
}

/** The UCP checkout AP2 embeds as `checkout_jwt`, from the countersigned purchase. */
export function checkoutObject(f: PurchaseFacts): Record<string, unknown> {
  const lines = f.lines ?? [];
  const totals: { type: string; amount: number }[] = [{ type: "total", amount: f.totalMinor }];
  if (f.breakdown) {
    totals.push({ type: "subtotal", amount: f.breakdown.items });
    if (f.breakdown.tax) totals.push({ type: "tax", amount: f.breakdown.tax });
    if (f.breakdown.shipping) totals.push({ type: "fulfillment", amount: f.breakdown.shipping });
    if (f.breakdown.discount) totals.push({ type: "discount", amount: -f.breakdown.discount });
  } else if (lines.length) {
    totals.push({
      type: "subtotal",
      amount: lines.reduce((s, l) => s + l.unitMinor * l.quantity, 0),
    });
  }
  return {
    id: f.orderId ?? f.alibiId,
    merchant: {
      id: f.merchant.id,
      name: f.merchant.name,
      ...(f.merchant.website ? { website: f.merchant.website } : {}),
    },
    line_items: lines.map((l, i) => ({
      id: `li_${i + 1}`,
      item: { id: l.sku, title: l.title, price: l.unitMinor },
      quantity: l.quantity,
      totals: [{ type: "subtotal", amount: l.unitMinor * l.quantity }],
    })),
    status: f.decision === "allow" ? "completed" : "canceled",
    currency: f.currency,
    totals,
    links: [{ type: "receipt", url: `${VERIFY_ORIGIN}/a/${f.alibiId}` }],
  };
}

function instrumentOf(f: PurchaseFacts): Record<string, string> {
  return f.card
    ? {
        id: `card:${f.card.lastFour}`,
        type: "CARD",
        description: `${f.card.issuer} •••• ${f.card.lastFour}`,
      }
    : { id: `paypal:${f.payee}`, type: "PAYPAL", description: "PayPal" };
}

/** A receipt's `reference`: the hash of the final segment of a closed mandate chain. */
export const receiptReference = (chain: string): string =>
  b64uSha256(chain.split("~~").at(-1) as string);

/** The closed mandates' payloads for a checkout JWT. */
function closedPayloads(f: PurchaseFacts, checkoutJwt: string) {
  const checkoutHash = b64uSha256(checkoutJwt);
  return {
    checkout: {
      vct: "mandate.checkout.1",
      checkout_jwt: checkoutJwt,
      checkout_hash: checkoutHash,
      iat: f.issuedAt,
    },
    payment: {
      vct: "mandate.payment.1",
      transaction_id: checkoutHash,
      payee: {
        id: f.payee,
        name: f.merchant.name,
        ...(f.merchant.website ? { website: f.merchant.website } : {}),
      },
      payment_amount: { amount: f.totalMinor, currency: f.currency },
      payment_instrument: instrumentOf(f),
      iat: f.issuedAt,
    },
  };
}

/** A terminal delegation hop over `open`, signed by the agent's `cnf` key. */
async function closeHop(
  open: string,
  mandate: Record<string, unknown>,
  agent: AgentSigner,
  o: { now: number; aud: string; nonce: string },
): Promise<string> {
  const { packedClaims, disclosures } = await pack(
    { delegate_payload: [mandate] },
    { delegate_payload: { _sd: [0] } },
    { hasher: sha256Hasher, alg: "sha-256" },
    salt,
  );
  const jwt = await new SignJWT({
    ...packedClaims,
    _sd_alg: "sha-256",
    iat: o.now,
    aud: o.aud,
    nonce: o.nonce,
    sd_hash: sdHash(open),
  })
    .setProtectedHeader({ alg: "ES256", typ: KB_SD_JWT, kid: agent.jwk.kid })
    .sign(agent.key);
  return `${open.slice(0, -1)}~~${jwt}~${disclosures.map((d) => `${d.encode()}~`).join("")}`;
}

async function receipts(
  f: PurchaseFacts,
  ref: AlibiRef,
  issuer: ExportSigner,
  closed: { checkout: string; payment: string },
) {
  const success = f.decision === "allow" && f.confirmationId !== undefined;
  const status = transform("StatusOfDecision", f.decision, statementFacts(f)) as string;
  const base = { status, iss: ISSUER, iat: f.issuedAt };
  const failure = {
    error: "declined",
    error_description: "Keelson's enclaves refused this cart under the mandate.",
  };
  const checkout = await issuer.sign(
    JWT,
    {
      ...base,
      reference: receiptReference(closed.checkout),
      ...(success && f.orderId ? { order_id: f.orderId } : {}),
      ...(status === "Error" ? failure : {}),
      keelson: keelsonClaim(f, ref, AP2_CHECKOUT_RECEIPT),
    },
    ref.statement,
  );
  const payment = await issuer.sign(
    JWT,
    {
      ...base,
      reference: receiptReference(closed.payment),
      payment_id: f.confirmationId ?? f.alibiId,
      ...(success
        ? {
            psp_confirmation_id: f.confirmationId,
            network_confirmation_id: f.authorizationId ?? f.confirmationId,
          }
        : {}),
      ...(status === "Error" ? failure : {}),
      keelson: keelsonClaim(f, ref, AP2_PAYMENT_RECEIPT),
    },
    ref.statement,
  );
  return { checkout, payment };
}

/** The nonce of a purchase's closed mandates: its countersigned request id, as a ULID. */
const nonceOf = (facts: StatementFacts) =>
  transform("UlidOfRequest", facts.request_id, facts) as string;

/**
 * A purchase as AP2 v0.2: the open mandates and the checkout JWT signed in the issuer slot, and,
 * when `k.agent` holds the mandate's `cnf` key, the closed mandates and their receipts.
 */
export async function exportAp2(
  f: PurchaseFacts,
  ref: AlibiRef,
  k: { issuer: ExportSigner; agent?: AgentSigner },
  o: { now: number },
): Promise<Ap2Export> {
  const open = await issueAp2Open(f, ref, k.issuer);
  const checkoutJwt = await k.issuer.sign(
    JWT,
    { ...checkoutObject(f), keelson: keelsonClaim(f, ref, AP2_CHECKOUT_JWT) },
    ref.statement,
  );
  const x: Ap2Export = {
    type: "keelson.ap2/1",
    alibi: ref,
    checkout: { open: open.checkout, checkout_jwt: checkoutJwt },
    payment: { open: open.payment },
    pending_close: closedPayloads(f, checkoutJwt),
  };
  if (!k.agent) return x;
  const closed = await closeAp2(x, k.agent, o);
  const r = await receipts(f, ref, k.issuer, {
    checkout: closed.checkout.closed as string,
    payment: closed.payment.closed as string,
  });
  closed.checkout.receipt = r.checkout;
  closed.payment.receipt = r.payment;
  return closed;
}

/** Closes an export's open mandates with the agent's `cnf` key. */
export async function closeAp2(
  x: Ap2Export,
  agent: AgentSigner,
  o: { now: number; aud?: { checkout?: string; payment?: string }; nonce?: string },
): Promise<Ap2Export> {
  if (!x.pending_close) throw new RangeError("the export has no open mandates to close");
  const facts = (openPayload(x.checkout.open).keelson as { facts: StatementFacts }).facts;
  const nonce = o.nonce ?? nonceOf(facts);
  const { pending_close: pending, ...rest } = x;
  return {
    ...rest,
    checkout: {
      ...x.checkout,
      closed: await closeHop(x.checkout.open, pending.checkout, agent, {
        now: o.now,
        aud: o.aud?.checkout ?? "merchant",
        nonce,
      }),
    },
    payment: {
      ...x.payment,
      closed: await closeHop(x.payment.open, pending.payment, agent, {
        now: o.now,
        aud: o.aud?.payment ?? "paypal",
        nonce,
      }),
    },
  };
}

/** The disclosed delegate payload of an SD-JWT segment `jwt~d~`. */
function delegateOf(segment: string): Record<string, unknown> | undefined {
  const d = segment.split("~")[1];
  if (!d) return undefined;
  const value = JSON.parse(new TextDecoder().decode(base64UrlDecode(d))) as unknown[];
  return value.at(-1) as Record<string, unknown>;
}

const base64UrlDecode = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

async function verifiesWith(jws: string, jwk: object): Promise<boolean> {
  try {
    await compactVerify(jws, await importJWK(jwk as never, "ES256"));
    return true;
  } catch {
    return false;
  }
}

async function issuedBy(jws: string, keys: EcPublicJwk[]): Promise<boolean> {
  const { kid } = decodeProtectedHeader(jws);
  const key = keys.find((k) => k.kid === kid);
  return key !== undefined && verifiesWith(jws, key);
}

/** Checks one closed chain `open~d~~closed~d~` and returns its delegate payload. */
async function closedChain(
  chain: string,
  aud: string,
  nonce: string,
): Promise<{ binding: boolean; nonce: boolean; leaf?: Record<string, unknown> }> {
  const [open, closed] = chain.split("~~") as [string, string];
  const cnf = delegateOf(`${open}~`)?.cnf as { jwk?: object } | undefined;
  const jwt = closed.split("~")[0] as string;
  const header = decodeProtectedHeader(jwt);
  const p = jwtPayload(jwt);
  const leaf = delegateOf(closed);
  const binding =
    cnf?.jwk !== undefined &&
    header.typ === KB_SD_JWT &&
    (await verifiesWith(jwt, cnf.jwk)) &&
    p.sd_hash === sdHash(`${open}~`) &&
    p.aud === aud &&
    typeof p.iat === "number" &&
    leaf !== undefined &&
    !("cnf" in leaf);
  return { binding, nonce: p.nonce === nonce, ...(leaf ? { leaf } : {}) };
}

/**
 * Verifies an AP2 export offline: the issuer signatures, each closed chain's binding to its open
 * mandate and to the countersigned request, and AP2's dispute checks (the checkout hash, the
 * payment's transaction id and both receipts' references).
 */
export async function verifyAp2(
  x: Ap2Export,
  o: { now: number; issuerKeys: EcPublicJwk[] },
): Promise<ExportReport> {
  const started = performance.now();
  const checks: { id: CheckId; ok: boolean; detail?: string }[] = [];
  const issuerSigned = [
    x.checkout.open.split("~")[0],
    x.payment.open.split("~")[0],
    x.checkout.checkout_jwt,
    x.checkout.receipt,
    x.payment.receipt,
  ].filter((j): j is string => typeof j === "string");
  const issuer = (await Promise.all(issuerSigned.map((j) => issuedBy(j, o.issuerKeys)))).every(
    Boolean,
  );
  checks.push({ id: "issuer", ok: issuer });

  const facts = (openPayload(x.checkout.open).keelson as { facts: StatementFacts }).facts;
  const nonce = nonceOf(facts);
  const reference = delegateOf(x.payment.open)?.constraints as
    | { type: string; conditional_transaction_id?: string }[]
    | undefined;
  let binding =
    reference?.find((c) => c.type === "payment.reference")?.conditional_transaction_id ===
    sdHash(x.checkout.open);
  let nonceOk = true;
  let references = true;
  if (x.checkout.closed && x.payment.closed) {
    const c = await closedChain(x.checkout.closed, "merchant", nonce);
    const p = await closedChain(x.payment.closed, "paypal", nonce);
    binding &&= c.binding && p.binding;
    nonceOk = c.nonce && p.nonce;
    const checkoutHash = b64uSha256(x.checkout.checkout_jwt);
    references =
      c.leaf?.checkout_jwt === x.checkout.checkout_jwt &&
      c.leaf?.checkout_hash === checkoutHash &&
      p.leaf?.transaction_id === checkoutHash &&
      (x.checkout.receipt === undefined ||
        jwtPayload(x.checkout.receipt).reference === receiptReference(x.checkout.closed)) &&
      (x.payment.receipt === undefined ||
        jwtPayload(x.payment.receipt).reference === receiptReference(x.payment.closed));
  }
  checks.push({ id: "chain_binding", ok: binding });
  checks.push({ id: "nonce", ok: nonceOk });
  checks.push({ id: "receipt_reference", ok: references });
  return { format: "ap2", ok: checks.every((c) => c.ok), checks, ms: performance.now() - started };
}
