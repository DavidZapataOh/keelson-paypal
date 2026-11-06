import { importJWK } from "jose";
import { describe, expect, it } from "vitest";
import {
  issueOpenMandate,
  issueUserCredential,
  OPEN_MANDATE_TYP,
  type OpenMandateParams,
  type P256PublicJwk,
  USER_CREDENTIAL_TYP,
  type UserCredentialParams,
  verifyCredential,
} from "../src/credentials.ts";
import vectors from "./vectors/issued.json" with { type: "json" };

interface Derived {
  secret: string;
  jwk: P256PublicJwk;
}

const publicKey = (d: Derived) => importJWK(d.jwk, "ES256") as Promise<CryptoKey>;
const privateKey = (d: Derived) =>
  importJWK(
    { ...d.jwk, d: Buffer.from(d.secret.slice(2), "hex").toString("base64url") },
    "ES256",
  ) as Promise<CryptoKey>;

const replay = (salts: string[]) => {
  let i = 0;
  return () => Uint8Array.from(Buffer.from((salts[i++] as string).slice(2), "hex"));
};

/** Every JWS in the token without its signature, which WebCrypto randomizes. */
const unsigned = (token: string) =>
  token
    .split("~")
    .map((part) => (part.split(".").length === 3 ? part.slice(0, part.lastIndexOf(".")) : part));

const issuer = vectors.issuer as Derived;
const holder = vectors.users[0] as Derived;
const l1Params = vectors.userCredential.params as UserCredentialParams;
const l2Params = vectors.openMandate.params as OpenMandateParams;

describe("credentials issued from derived keys", () => {
  it("verifies the user credential with the derived issuer key", async () => {
    const v = await verifyCredential(
      vectors.userCredential.expected,
      USER_CREDENTIAL_TYP,
      await publicKey(issuer),
    );
    expect(v.claims.sub).toBe(l1Params.sub);
    expect((v.claims.cnf as { jwk: P256PublicJwk }).jwk).toEqual(holder.jwk);
  });

  it("verifies the open mandate signed by the derived holder key", async () => {
    const v = await verifyCredential(
      vectors.openMandate.expected,
      OPEN_MANDATE_TYP,
      await publicKey(issuer),
      vectors.openMandate.verify,
    );
    expect(v.mandate.mid).toBe(l2Params.nonce);
  });

  it("reproduces the user credential from its salts and iat", async () => {
    const token = await issueUserCredential(
      l1Params,
      await privateKey(issuer),
      replay(vectors.userCredential.salts),
    );
    expect(unsigned(token)).toEqual(unsigned(vectors.userCredential.expected));
  });

  it("reproduces the open mandate from its salts and iat", async () => {
    const token = await issueOpenMandate(
      l2Params,
      await privateKey(holder),
      replay(vectors.openMandate.salts),
    );
    expect(unsigned(token)).toEqual(unsigned(vectors.openMandate.expected));
  });

  it("draws fresh salts by default", async () => {
    const key = await privateKey(issuer);
    const [a, b] = await Promise.all([
      issueUserCredential(l1Params, key),
      issueUserCredential(l1Params, key),
    ]);
    expect(a.split("~")[1]).not.toBe(b.split("~")[1]);
  });

  it("rejects an iat that is not whole seconds", async () => {
    const key = await privateKey(issuer);
    await expect(issueUserCredential({ ...l1Params, iat: 1.5 }, key)).rejects.toThrow(RangeError);
    await expect(issueOpenMandate({ ...l2Params, iat: Number.NaN }, key)).rejects.toThrow(
      RangeError,
    );
  });
});
