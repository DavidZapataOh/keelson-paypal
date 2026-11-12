import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, gt, sql, teeSigners } from "@keelson/db";
import { calculateJwkThumbprint, type JWK } from "jose";
import type { Deps } from "../app.ts";
import { problem } from "../problem.ts";

/**
 * `GET /v1/credentials/issuer/jwks.json`: the key the user credential's issuer signs with, for any
 * SD-JWT VC verifier that follows `iss` to `/.well-known/jwt-vc-issuer` (draft-ietf-oauth-sd-jwt-vc
 * §4). It is leg A's issuer key, served only while an admitted TDX attestation binds its thumbprint.
 */
export function registerCredentialIssuer(app: OpenAPIHono, deps: Pick<Deps, "db" | "tee">): void {
  app.get("/v1/credentials/issuer/jwks.json", async (c) => {
    if (!deps.tee) {
      return problem(c, 503, "tee-unavailable", "TEE unavailable", "No TEE leg serves the issuer.");
    }
    let jwk: JWK;
    try {
      const health = (await deps.tee.client.a.health()) as { issuer?: JWK };
      if (!health.issuer) throw new Error("leg a serves no credential issuer");
      jwk = health.issuer;
    } catch {
      return problem(c, 503, "tee-unavailable", "TEE unavailable", "Leg A did not answer.");
    }
    const kid = await calculateJwkThumbprint(jwk, "sha256");
    const hex = `0x${Buffer.from(kid, "base64url").toString("hex")}`;
    const [attested] = await deps.db
      .select({ address: teeSigners.address })
      .from(teeSigners)
      .where(
        and(
          sql`${teeSigners.teeKind} = 1`,
          gt(teeSigners.expiresAt, new Date()),
          sql`lower(${teeSigners.binding}->>'issuerJwkThumbprint') = ${hex}`,
        ),
      )
      .limit(1);
    const keys = attested
      ? [{ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid, use: "sig", alg: "ES256" }]
      : [];
    return c.json({ keys }, 200, {
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    });
  });
}
