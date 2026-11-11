import { readFileSync } from "node:fs";
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  jwtVerify,
} from "jose";
import { expect, test } from "vitest";
import { BindingError } from "../src/bindings.ts";
import { purchaseFacts, statementFacts } from "../src/facts.ts";
import { sdHash } from "../src/jose.ts";
import { jwks } from "../src/signer.ts";
import { localExportSigner } from "../src/testing.ts";
import { ALLOW_PAYPAL, alibi } from "./fixtures.ts";

const facts = statementFacts(purchaseFacts(alibi(ALLOW_PAYPAL)));
const statement = "0oRYI6MBJgRUAA";

async function testIssuer() {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return localExportSigner(await exportJWK(privateKey), () => facts);
}

test("the issuer signs a bound payload as a compact ES256 JWS under its thumbprint", async () => {
  const issuer = await testIssuer();
  const jws = await issuer.sign("keelson.export/1", { keelson: { statement, facts } }, statement);
  const header = decodeProtectedHeader(jws);
  expect(header).toEqual({
    alg: "ES256",
    typ: "keelson.export/1",
    kid: await calculateJwkThumbprint(issuer.jwk),
  });
  expect(issuer.jwk.kid).toBe(header.kid);
  const { payload } = await jwtVerify(jws, createLocalJWKSet(jwks(issuer.jwk)));
  expect(payload.keelson).toEqual({ statement, facts });
});

test("the issuer refuses a payload whose facts differ, as leg A does", async () => {
  const issuer = await testIssuer();
  const bad = { keelson: { statement, facts: { ...facts, amount_minor: 1 } } };
  await expect(issuer.sign("keelson.export/1", bad, statement)).rejects.toBeInstanceOf(
    BindingError,
  );
});

test("sd_hash matches RFC 9901's presentation example", () => {
  const v = JSON.parse(
    readFileSync(new URL("./rfc9901-presentation.json", import.meta.url), "utf8"),
  );
  expect(sdHash(v.sd_jwt)).toBe(v.sd_hash);
});
