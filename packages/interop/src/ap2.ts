import { pack, uint8ArrayToBase64Url } from "@sd-jwt/core";
import { ap2Constraints } from "./constraints.ts";
import type { PurchaseFacts } from "./facts.ts";
import { statementFacts } from "./facts.ts";
import { jwtPayload, sdHash, sha256Hasher } from "./jose.ts";
import type { ExportSigner } from "./signer.ts";
import type { AlibiRef } from "./statement.ts";

/** The export profile of AP2's root (open) mandates. */
export const AP2_OPEN = "ap2.open/1";
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
