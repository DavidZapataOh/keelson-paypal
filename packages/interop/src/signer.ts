import { BindingError } from "./bindings.ts";

/** A P-256 public key as a JWK, `kid` its RFC 7638 thumbprint. */
export interface EcPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
}

/**
 * Signs export payloads in the issuer slot of a standard. The issuer signs only payloads bound to
 * the purchase's logged statement (`checkBinding`).
 */
export interface ExportSigner {
  jwk: EcPublicJwk;
  /** A compact JWS with header `{ alg: "ES256", typ, kid }`. */
  sign(typ: string, payload: Record<string, unknown>, statement: string): Promise<string>;
}

/** The agent's `cnf` key, which signs the closed mandates. */
export interface AgentSigner {
  jwk: EcPublicJwk;
  key: CryptoKey;
}

/** Why an export is not produced. */
export class ExportRefused extends Error {
  readonly reason:
    | "denied"
    | "no_cart"
    | "v1_alibi"
    | "no_merchant_origin"
    | "no_http_key"
    | "signer_unavailable";

  constructor(reason: ExportRefused["reason"]) {
    super(reason);
    this.name = "ExportRefused";
    this.reason = reason;
  }
}

/** A JWK Set (RFC 7517 section 5). */
export const jwks = (...keys: EcPublicJwk[]): { keys: EcPublicJwk[] } => ({ keys });

const CODES = new Set(["export.facts", "export.binding", "export.typ", "export.statement"]);

/**
 * The enclave issuer: leg A's `POST /v1/exports/sign`, which signs with its attested issuer key
 * after it checks the statement, its receipt and the binding itself.
 */
export function teeExportSigner(o: { url: string; token: string; jwk: EcPublicJwk }): ExportSigner {
  return {
    jwk: o.jwk,
    async sign(typ, payload, statement) {
      const res = await fetch(new URL("/v1/exports/sign", o.url), {
        method: "POST",
        headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" },
        body: JSON.stringify({ typ, payload, statement }),
      });
      if (res.status === 404) throw new ExportRefused("signer_unavailable");
      const body = (await res.json().catch(() => ({}))) as { jws?: string; code?: string };
      if (res.status === 400 && body.code && CODES.has(body.code)) {
        throw new BindingError(body.code as BindingError["code"]);
      }
      if (!res.ok || typeof body.jws !== "string") {
        throw new Error(`export signer answered ${res.status}`);
      }
      return body.jws;
    },
  };
}
