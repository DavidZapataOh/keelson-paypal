import { calculateJwkThumbprint, importJWK, type JWK, SignJWT } from "jose";
import { checkBinding } from "./bindings.ts";
import type { StatementFacts } from "./facts.ts";
import type { EcPublicJwk, ExportSigner } from "./signer.ts";

/**
 * An issuer over a local P-256 key, for tests: it runs the same binding checks as leg A, with
 * `factsOf` standing in for leg A's reading of the statement.
 */
export async function localExportSigner(
  privateJwk: JWK,
  factsOf: (statement: string) => StatementFacts,
): Promise<ExportSigner & { privateKey: CryptoKey }> {
  const key = await importJWK(privateJwk, "ES256");
  const { kty, crv, x, y } = privateJwk as { kty: "EC"; crv: "P-256"; x: string; y: string };
  const jwk: EcPublicJwk = {
    kty,
    crv,
    x,
    y,
    kid: await calculateJwkThumbprint({ kty, crv, x, y }),
  };
  return {
    jwk,
    privateKey: key as CryptoKey,
    async sign(typ, payload, statement) {
      checkBinding(typ, payload, factsOf(statement), statement);
      return new SignJWT(payload).setProtectedHeader({ alg: "ES256", typ, kid: jwk.kid }).sign(key);
    },
  };
}
