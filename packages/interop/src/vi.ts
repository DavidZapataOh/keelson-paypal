import { uint8ArrayToBase64Url } from "@sd-jwt/core";
import { base64url, decodeProtectedHeader, SignJWT } from "jose";
import { instrumentOf, keelsonClaim, nonceOf, signCheckoutJwt } from "./ap2.ts";
import { viConstraints } from "./constraints.ts";
import { type PurchaseFacts, type StatementFacts, statementFacts } from "./facts.ts";
import { b64uSha256, issuedBy, jwtPayload, verifiesWith } from "./jose.ts";
import type { AgentSigner, EcPublicJwk, ExportSigner } from "./signer.ts";
import type { AlibiRef } from "./statement.ts";
import type { CheckId, ExportReport } from "./verify.ts";

/**
 * The `vct` of Keelson's Layer 1 credential.
 *
 * @internal
 */
export const VI_L1_VCT = "https://keelson.finance/credentials/paypal/v1";
/** The export profiles of the issuer-signed layers. */
const VI_L1 = "vi.l1/1";
/** @internal */
export const VI_L2 = "vi.l2/1";

const ISSUER = "https://keelson.finance";
const NETWORK_AUD = "https://www.paypal.com";
const SD_JWT = "sd+jwt";
const KB_SD_JWT_KB = "kb-sd-jwt+kb";
const KB_SD_JWT = "kb-sd-jwt";
const CHECKOUT_OPEN = "mandate.checkout.open.1";
const PAYMENT_OPEN = "mandate.payment.open.1";
const CHECKOUT_FINAL = "mandate.checkout.1";
const PAYMENT_FINAL = "mandate.payment.1";
/** The recommended L3 lifetime, in seconds. */
const L3_LIFETIME = 300;

type Json = Record<string, unknown>;

/** A purchase as a Verifiable Intent v0.1 Autonomous chain, with each recipient's L2 view. */
export interface ViExport {
  type: "keelson.vi/1";
  alibi: AlibiRef;
  /** The serialized L1, `jwt~`. */
  l1: string;
  /** The serialized L2 with every disclosure. */
  l2: string;
  /** The L2 as the merchant sees it: the checkout mandate and the item disclosures. */
  l2_checkout: string;
  /** The L2 as the network sees it: the payment mandate and the merchant disclosures. */
  l2_payment: string;
  l3_payment?: string;
  l3_checkout?: string;
  network_aud: "https://www.paypal.com";
  merchant_aud: string;
  /** The L3 nonce: the countersigned request id, as a ULID. */
  nonce: string;
  /** The L3 mandates, when the exporter does not hold the agent's key. */
  pending_close?: { payment: Json; merchant: Json; checkout: Json };
}

const salt = () => uint8ArrayToBase64Url(crypto.getRandomValues(new Uint8Array(16)));

/** An array-element disclosure `[salt, value]` (RFC 9901 section 4.2.2). */
const disclose = (value: unknown) => base64url.encode(JSON.stringify([salt(), value]));
const refTo = (disclosure: string) => ({ "...": b64uSha256(disclosure) });
const present = (jwt: string, disclosures: string[]) => `${[jwt, ...disclosures].join("~")}~`;
const disclosedValue = (disclosure: string): unknown =>
  (JSON.parse(new TextDecoder().decode(base64url.decode(disclosure))) as unknown[]).at(-1);

/** The merchant's URI: its website, else its id. */
const merchantUri = (f: PurchaseFacts) => f.merchant.website ?? f.merchant.id;

/** Disclosures for `entries`, one per distinct `id`, and the refs a constraint lists. */
function discloseAll(entries: Json[]) {
  const byId = new Map<string, string>();
  for (const e of entries) {
    if (!byId.has(e.id as string)) byId.set(e.id as string, disclose(e));
  }
  return {
    disclosures: [...byId.values()],
    refs: (list: Json[]) => list.map((e) => refTo(byId.get(e.id as string) as string)),
  };
}

/**
 * The L2 mandates as Verifiable Intent's reference issues them: merchants and acceptable items are
 * standalone disclosures referenced from the constraints, and the payment mandate's
 * `mandate.payment.reference` names the checkout mandate's disclosure.
 */
function mandates(f: PurchaseFacts) {
  const c = viConstraints(f);
  const merchantList = (cs: Json[], type: string) =>
    cs.filter((x) => x.type === type).flatMap((x) => x.allowed as Json[]);
  const merchants = discloseAll([
    ...merchantList(c.checkout, "mandate.checkout.allowed_merchants"),
    ...merchantList(c.payment, "mandate.payment.allowed_payees"),
  ]);
  const lines = c.checkout
    .filter((x) => x.type === "mandate.checkout.line_items")
    .flatMap((x) => x.items as { acceptable_items: Json[] }[]);
  const items = discloseAll(lines.flatMap((l) => l.acceptable_items));
  const cnf = f.mandate.agent?.cnf;
  const summary = f.mandate.intent?.prompt_summary;
  const checkout = disclose({
    vct: CHECKOUT_OPEN,
    cnf,
    constraints: c.checkout.map((x) =>
      x.type === "mandate.checkout.allowed_merchants"
        ? { type: x.type, allowed: merchants.refs(x.allowed as Json[]) }
        : {
            type: x.type,
            items: (x.items as Json[]).map((l) => ({
              id: l.id,
              acceptable_items: items.refs(l.acceptable_items as Json[]),
              quantity: l.quantity,
            })),
            match_mode: "minimum",
          },
    ),
    ...(summary ? { prompt_summary: summary } : {}),
  });
  const payment = disclose({
    vct: PAYMENT_OPEN,
    cnf,
    constraints: [
      ...c.payment.map((x) =>
        x.type === "mandate.payment.allowed_payees"
          ? { type: x.type, allowed: merchants.refs(x.allowed as Json[]) }
          : x,
      ),
      { type: "mandate.payment.reference", conditional_transaction_id: b64uSha256(checkout) },
    ],
    payment_instrument: instrumentOf(f),
  });
  return { c, checkout, payment, merchants: merchants.disclosures, items: items.disclosures };
}

/** The agent's identity as the L2 audience: its ERC-8004 registry and id. */
function agentAud(f: PurchaseFacts): string {
  const op = f.mandate.agent?.operator;
  return op?.agent_registry ? `${op.agent_registry}:${op.agent_id ?? f.agentId}` : f.agentId;
}

/**
 * A purchase as a Verifiable Intent v0.1 Autonomous chain. The issuer signs L1, which binds its own
 * key, and L2, the user's mandate as the enclaves checked it (the user's passkey assertion rides
 * in `keelson.user_auth`). With `k.agent`, the agent signs L3a for PayPal and L3b for the merchant;
 * otherwise the L3 mandates are left in `pending_close` for `closeVi`.
 */
export async function exportVi(
  f: PurchaseFacts,
  ref: AlibiRef,
  k: { issuer: ExportSigner; agent?: AgentSigner },
  o: { now: number },
): Promise<ViExport> {
  const m = f.mandate;
  const l1 = present(
    await k.issuer.sign(
      SD_JWT,
      {
        iss: ISSUER,
        sub: m.user?.sub,
        iat: m.iat,
        exp: m.exp,
        vct: VI_L1_VCT,
        cnf: { jwk: k.issuer.jwk },
        _sd: [],
        _sd_alg: "sha-256",
        keelson: keelsonClaim(f, ref, VI_L1),
      },
      ref.statement,
    ),
    [],
  );
  const d = mandates(f);
  const disclosures = [...d.merchants, ...d.items, d.checkout, d.payment];
  const l2Jwt = await k.issuer.sign(
    KB_SD_JWT_KB,
    {
      nonce: m.nonce,
      aud: agentAud(f),
      iat: m.iat,
      sd_hash: b64uSha256(l1),
      delegate_payload: [refTo(d.checkout), refTo(d.payment)],
      _sd_alg: "sha-256",
      _sd: disclosures.map(b64uSha256),
      iss: ISSUER,
      exp: m.exp,
      keelson: {
        ...keelsonClaim(f, ref, VI_L2),
        l2: f.l2,
        user_auth: f.userAuth,
        constraints: d.c.keelsonOnly,
        refined: d.c.refined,
      },
      // VI README section 9.2: the optional `agent_attestation` claim.
      agent_attestation: { type: "application/scitt-statement+cose", value: ref.statement },
    },
    ref.statement,
  );
  const checkoutJwt = await signCheckoutJwt(f, ref, k.issuer);
  const checkoutHash = b64uSha256(checkoutJwt);
  const payee = { id: f.payee, name: f.merchant.name, website: merchantUri(f) };
  const x: ViExport = {
    type: "keelson.vi/1",
    alibi: ref,
    l1,
    l2: present(l2Jwt, disclosures),
    l2_checkout: present(l2Jwt, [d.checkout, ...d.items]),
    l2_payment: present(l2Jwt, [d.payment, ...d.merchants]),
    network_aud: NETWORK_AUD,
    merchant_aud: merchantUri(f),
    nonce: nonceOf(statementFacts(f)),
    pending_close: {
      payment: {
        vct: PAYMENT_FINAL,
        transaction_id: checkoutHash,
        payee,
        payment_amount: { currency: f.currency, amount: f.totalMinor },
        payment_instrument: instrumentOf(f),
      },
      merchant: payee,
      checkout: { vct: CHECKOUT_FINAL, checkout_jwt: checkoutJwt, checkout_hash: checkoutHash },
    },
  };
  return k.agent ? closeVi(x, k.agent, o) : x;
}

/** An L3 KB-SD-JWT over `values`, each a disclosed element of `delegate_payload`. */
async function l3(
  values: Json[],
  agent: AgentSigner,
  claims: { nonce: string; aud: string; l2: string; now: number },
): Promise<string> {
  const disclosures = values.map(disclose);
  const jwt = await new SignJWT({
    nonce: claims.nonce,
    aud: claims.aud,
    sd_hash: b64uSha256(claims.l2),
    iat: claims.now,
    delegate_payload: disclosures.map(refTo),
    _sd_alg: "sha-256",
    exp: claims.now + L3_LIFETIME,
  })
    .setProtectedHeader({ alg: "ES256", typ: KB_SD_JWT, kid: agent.jwk.kid })
    .sign(agent.key);
  return present(jwt, disclosures);
}

/** Signs an export's pending L3a and L3b with the agent's `cnf` key. */
export async function closeVi(
  x: ViExport,
  agent: AgentSigner,
  o: { now: number },
): Promise<ViExport> {
  if (!x.pending_close) throw new RangeError("the export has no pending L3 mandates");
  const { pending_close: p, ...rest } = x;
  const facts = (
    jwtPayload(parts(x.l2).jwt).keelson as { facts?: { decision?: string } } | undefined
  )?.facts;
  // A refused purchase authorizes no payment: only its checkout is closed.
  const payment =
    facts?.decision === "allow"
      ? {
          l3_payment: await l3([p.merchant, p.payment], agent, {
            nonce: x.nonce,
            aud: x.network_aud,
            l2: x.l2_payment,
            now: o.now,
          }),
        }
      : {};
  return {
    ...rest,
    ...payment,
    l3_checkout: await l3([p.checkout], agent, {
      nonce: x.nonce,
      aud: x.merchant_aud,
      l2: x.l2_checkout,
      now: o.now,
    }),
  };
}

/** The issuer JWT and disclosures of a serialized SD-JWT. */
function parts(sdJwt: string): { jwt: string; disclosures: string[] } {
  const [jwt, ...rest] = sdJwt.split("~");
  return { jwt: jwt as string, disclosures: rest.filter(Boolean) };
}

/** The final mandate an L3 discloses with `vct`, checked against its signed refs. */
function finalMandate(sdJwt: string, vct: string): Json | undefined {
  const { jwt, disclosures } = parts(sdJwt);
  const signed = new Set(
    (jwtPayload(jwt).delegate_payload as { "..."?: string }[] | undefined)?.map((r) => r["..."]),
  );
  return disclosures
    .filter((d) => signed.has(b64uSha256(d)))
    .map(disclosedValue)
    .find((v): v is Json => (v as Json | null)?.vct === vct);
}

/** Checks one L3 against the agent's key and the L2 view it was presented with. */
async function l3Binds(
  sdJwt: string,
  cnf: EcPublicJwk,
  view: string,
  aud: string,
  vct: string,
): Promise<boolean> {
  const { jwt } = parts(sdJwt);
  const header = decodeProtectedHeader(jwt);
  const p = jwtPayload(jwt);
  return (
    header.typ === KB_SD_JWT &&
    header.kid === cnf.kid &&
    (await verifiesWith(jwt, cnf)) &&
    p.sd_hash === b64uSha256(view) &&
    p.aud === aud &&
    !("cnf" in p) &&
    finalMandate(sdJwt, vct) !== undefined
  );
}

/**
 * Verifies a Verifiable Intent export offline: L1, L2 and the checkout JWT under `issuerKeys`;
 * L2 under L1's `cnf`; each L2 view and L3 to the L2 and its mandates' `cnf`; the L3s' audiences,
 * cross-reference and nonce, which must be the countersigned request.
 */
export async function verifyVi(
  x: ViExport,
  o: { now: number; issuerKeys: EcPublicJwk[] },
): Promise<ExportReport> {
  const started = performance.now();
  const checks: { id: CheckId; ok: boolean; detail?: string }[] = [];
  const l1 = parts(x.l1).jwt;
  const l2 = parts(x.l2);
  const l1p = jwtPayload(l1);
  const l2p = jwtPayload(l2.jwt);
  const checkoutL3 = x.l3_checkout ? finalMandate(x.l3_checkout, CHECKOUT_FINAL) : undefined;
  const checkoutJwt = (checkoutL3 ?? x.pending_close?.checkout)?.checkout_jwt as string | undefined;
  const issued = await Promise.all(
    [l1, l2.jwt, checkoutJwt].map((j) => j !== undefined && issuedBy(j, o.issuerKeys)),
  );
  checks.push({ id: "issuer", ok: issued.every(Boolean) });

  const userKey = (l1p.cnf as { jwk?: EcPublicJwk } | undefined)?.jwk;
  const sd = new Set(l2p._sd as string[]);
  const byVct = (vct: string) =>
    l2.disclosures.find((d) => (disclosedValue(d) as Json)?.vct === vct);
  const checkoutDisc = byVct(CHECKOUT_OPEN);
  const paymentDisc = byVct(PAYMENT_OPEN);
  const payment = paymentDisc ? (disclosedValue(paymentDisc) as Json) : undefined;
  const cnf = (payment?.cnf as { jwk?: EcPublicJwk } | undefined)?.jwk;
  const reference = (payment?.constraints as Json[] | undefined)?.find(
    (c) => c.type === "mandate.payment.reference",
  );
  const view = (s: string, own: string | undefined) => {
    const v = parts(s);
    return (
      v.jwt === l2.jwt &&
      own !== undefined &&
      v.disclosures.includes(own) &&
      v.disclosures.every((d) => sd.has(b64uSha256(d)))
    );
  };
  let binding =
    decodeProtectedHeader(l1).typ === SD_JWT &&
    l1p.vct === VI_L1_VCT &&
    decodeProtectedHeader(l2.jwt).typ === KB_SD_JWT_KB &&
    userKey !== undefined &&
    (await verifiesWith(l2.jwt, userKey)) &&
    l2p.sd_hash === b64uSha256(x.l1) &&
    l2.disclosures.every((d) => sd.has(b64uSha256(d))) &&
    checkoutDisc !== undefined &&
    reference?.conditional_transaction_id === b64uSha256(checkoutDisc) &&
    cnf !== undefined &&
    view(x.l2_checkout, checkoutDisc) &&
    view(x.l2_payment, paymentDisc);

  let nonce = true;
  const facts = (l2p.keelson as { facts?: StatementFacts } | undefined)?.facts;
  // An allowed purchase closes both L3s or neither; a refused one closes only its checkout.
  binding &&=
    facts?.decision === "allow"
      ? Boolean(x.l3_payment) === Boolean(x.l3_checkout)
      : x.l3_payment === undefined;
  if (x.l3_checkout && cnf && facts) {
    binding &&=
      (await l3Binds(x.l3_checkout, cnf, x.l2_checkout, x.merchant_aud, CHECKOUT_FINAL)) &&
      checkoutL3?.checkout_hash === b64uSha256(checkoutJwt as string);
    if (x.l3_payment) {
      binding &&=
        (await l3Binds(x.l3_payment, cnf, x.l2_payment, x.network_aud, PAYMENT_FINAL)) &&
        finalMandate(x.l3_payment, PAYMENT_FINAL)?.transaction_id === checkoutL3?.checkout_hash;
    }
    const expected = nonceOf(facts);
    nonce =
      x.nonce === expected &&
      [x.l3_payment, x.l3_checkout]
        .filter((s): s is string => s !== undefined)
        .every((s) => jwtPayload(parts(s).jwt).nonce === expected);
  }
  checks.push({ id: "chain_binding", ok: binding });
  checks.push({ id: "nonce", ok: nonce });
  return { format: "vi", ok: checks.every((c) => c.ok), checks, ms: performance.now() - started };
}
