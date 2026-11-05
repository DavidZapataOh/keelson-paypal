import { createHash } from "node:crypto";
import { pack } from "@sd-jwt/core";
import { exportJWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { hSd, mandateChallenge } from "../src/challenge.ts";
import { mandateCommitment } from "../src/commitment.ts";
import {
  issueOpenMandate,
  issueUserCredential,
  OPEN_MANDATE_TYP,
  USER_CREDENTIAL_TYP,
  type UserAuth,
  verifyCredential,
} from "../src/credentials.ts";
import { type Mandate, parseMandate } from "../src/schema.ts";
import { buildSdPayload } from "../src/sd.ts";
import demo from "./fixtures/demo-mandate.json" with { type: "json" };

const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const generate = () => crypto.subtle.generateKey(ES256, true, ["sign", "verify"]);
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const randomSalt = () => crypto.getRandomValues(new Uint8Array(16));

const publicJwk = async (k: CryptoKeyPair) => {
  const { kty, crv, x, y } = await exportJWK(k.publicKey);
  return { kty, crv, x, y } as { kty: "EC"; crv: "P-256"; x: string; y: string };
};

/** ASN.1 DER `Ecdsa-Sig-Value` from a 64-byte `r || s`, as WebAuthn requires for ES256. */
function der(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    return (v[0] as number) & 0x80 ? [0x02, v.length + 1, 0, ...v] : [0x02, v.length, ...v];
  };
  const body = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

/** A WebAuthn assertion (WebAuthn Level 3, section 7.2) over `challenge`, signed by a software P-256 key. */
async function assertion(passkey: CryptoKeyPair, challenge: Uint8Array): Promise<UserAuth> {
  const authenticatorData = Buffer.concat([
    sha256("keelson.finance"),
    Buffer.from([0x05]),
    Buffer.from([0, 0, 0, 1]),
  ]);
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: b64u(challenge),
      origin: "https://keelson.finance",
      crossOrigin: false,
    }),
  );
  const signed = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, passkey.privateKey, signed),
  );
  return {
    authenticatorData: b64u(authenticatorData),
    clientDataJSON: b64u(clientDataJSON),
    signature: b64u(der(sig)),
  };
}

let issuer: CryptoKeyPair;
let holder: CryptoKeyPair;
let passkey: CryptoKeyPair;
let agent: CryptoKeyPair;
let other: CryptoKeyPair;
let l1: string;

const userParams = async () => ({
  iss: "https://keelson.finance",
  sub: "kls_usr_7f3a9c21",
  cred: { id: "Zk3p0xQmH8vN1sLwT5uYdA", rp_id: "keelson.finance", jwk: await publicJwk(passkey) },
  holderJwk: await publicJwk(holder),
});

beforeAll(async () => {
  [issuer, holder, passkey, agent, other] = await Promise.all([
    generate(),
    generate(),
    generate(),
    generate(),
    generate(),
  ]);
  l1 = await issueUserCredential(await userParams(), issuer.privateKey);
});

/** The demo mandate, re-keyed to the generated passkey and agent and valid from now. */
async function liveMandate(): Promise<Mandate> {
  const now = Math.floor(Date.now() / 1000);
  const m = structuredClone(demo) as unknown as Mandate;
  m.iat = now;
  m.nbf = now;
  m.exp = now + 7 * 86400;
  m.user.cred.jwk = await publicJwk(passkey);
  m.agent.cnf.jwk = { ...(await publicJwk(agent)), kid: "agt-01" };
  return parseMandate(m);
}

async function openMandate() {
  const m = await liveMandate();
  const salt = randomSalt();
  const { payloadSd, disclosures } = await buildSdPayload(m, randomSalt);
  const h = hSd(payloadSd);
  const cm = await mandateCommitment(m, salt);
  const challenge = mandateChallenge(h, cm);
  const userAuth = await assertion(passkey, challenge);
  const token = await issueOpenMandate(
    { userCredential: l1, payloadSd, disclosures, userAuth, aud: "agt-01", nonce: m.nonce },
    holder.privateKey,
  );
  return { m, cm, token, payloadSd, disclosures, challenge, userAuth };
}

/** A small open mandate, so that flipping each of its bytes is cheap. */
async function smallOpenMandate(): Promise<string> {
  const hash = {
    alg: "sha-256",
    hasher: (data: string | ArrayBuffer) =>
      new Uint8Array(sha256(typeof data === "string" ? data : new Uint8Array(data))),
  };
  const salt = () => b64u(randomSalt());
  const { packedClaims, disclosures } = await pack(
    { cnf: { jwk: await publicJwk(agent) }, cap: 100 },
    { _sd: ["cap"] },
    hash,
    salt,
  );
  const userAuth = await assertion(passkey, randomSalt());
  return issueOpenMandate(
    {
      userCredential: l1,
      payloadSd: packedClaims as object,
      disclosures: disclosures.map((d) => d.encode()),
      userAuth,
      aud: "a",
      nonce: "n",
    },
    holder.privateKey,
  );
}

describe("user credential (L1)", () => {
  it("is a dc+sd-jwt, ES256, with cnf.jwk set to the holder key", async () => {
    const v = await verifyCredential(l1, USER_CREDENTIAL_TYP, issuer.publicKey);
    expect(v.header).toMatchObject({ typ: "dc+sd-jwt", alg: "ES256" });
    expect(v.claims.cnf).toEqual({ jwk: await publicJwk(holder) });
    expect(v.claims.cred).toEqual((await userParams()).cred);
    expect(v.claims.sub).toBe("kls_usr_7f3a9c21");
    expect(typeof v.claims.vct).toBe("string");
    expect(l1.endsWith("~")).toBe(true);
  });

  it("never carries private key material in cnf", async () => {
    const leaky = { ...(await userParams()), holderJwk: await exportJWK(holder.privateKey) };
    const token = await issueUserCredential(leaky as never, issuer.privateKey);
    const v = await verifyCredential(token, USER_CREDENTIAL_TYP, issuer.publicKey);
    expect(v.claims.cnf).toEqual({ jwk: await publicJwk(holder) });
  });

  it("fails with a wrong key or a wrong typ", async () => {
    await expect(verifyCredential(l1, USER_CREDENTIAL_TYP, other.publicKey)).rejects.toThrow();
    await expect(verifyCredential(l1, OPEN_MANDATE_TYP, issuer.publicKey)).rejects.toThrow();
  });
});

describe("open mandate (L2)", () => {
  it("is a kb-sd-jwt+kb chained to L1, carrying the passkey assertion over M", async () => {
    const { m, cm, token, payloadSd, challenge, userAuth } = await openMandate();
    expect(token.startsWith(`${l1}~`)).toBe(true);
    const v = await verifyCredential(token, OPEN_MANDATE_TYP, issuer.publicKey);
    expect(v.header).toMatchObject({ typ: "kb-sd-jwt+kb", alg: "ES256" });
    expect(v.userCredential.claims.cnf).toEqual({ jwk: await publicJwk(holder) });
    expect(v.payload).toEqual(payloadSd);
    expect(v.claims).toEqual({ ...m, cnf: { jwk: m.agent.cnf.jwk } });
    expect(v.userAuth).toEqual(userAuth);

    // A verifier recomputes M from the signed payload and C_m, and finds it in the assertion.
    expect(mandateChallenge(hSd(v.payload), cm)).toEqual(challenge);
    const clientData = JSON.parse(Buffer.from(v.userAuth.clientDataJSON, "base64url").toString());
    expect(clientData.challenge).toBe(b64u(challenge));
  });

  it("lets the holder withhold delegated disclosures", async () => {
    const { token, disclosures } = await openMandate();
    const login = disclosures.find(isLogin);
    const v = await verifyCredential(
      token.replace(`~${login}~`, "~"),
      OPEN_MANDATE_TYP,
      issuer.publicKey,
    );
    expect((v.claims.user as Record<string, unknown>).app_login_id).toBeUndefined();
  });

  it("fails with a wrong issuer key, a wrong holder key or a wrong typ", async () => {
    const { m, token, payloadSd, disclosures, userAuth } = await openMandate();
    await expect(verifyCredential(token, OPEN_MANDATE_TYP, other.publicKey)).rejects.toThrow();
    await expect(verifyCredential(token, USER_CREDENTIAL_TYP, issuer.publicKey)).rejects.toThrow();
    const notHolder = await issueOpenMandate(
      { userCredential: l1, payloadSd, disclosures, userAuth, aud: "agt-01", nonce: m.nonce },
      other.privateKey,
    );
    await expect(verifyCredential(notHolder, OPEN_MANDATE_TYP, issuer.publicKey)).rejects.toThrow();
  });

  it("requires a delegate cnf", async () => {
    const { m, payloadSd, disclosures, userAuth } = await openMandate();
    const { cnf: _, ...noCnf } = payloadSd as Record<string, unknown>;
    await expect(
      issueOpenMandate(
        { userCredential: l1, payloadSd: noCnf, disclosures, userAuth, aud: "a", nonce: m.nonce },
        holder.privateKey,
      ),
    ).rejects.toThrow(/cnf/);
  });

  it("fails when any byte of the token changes", async () => {
    const token = await smallOpenMandate();
    expect(token.length).toBeLessThan(2000);
    await verifyCredential(token, OPEN_MANDATE_TYP, issuer.publicKey);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const accepted: number[] = [];
    for (let i = 0; i < token.length; i++) {
      const c = token[i] as string;
      const j = alphabet.indexOf(c);
      const flipped = j < 0 ? "A" : (alphabet[j ^ 1] as string);
      const tampered = token.slice(0, i) + flipped + token.slice(i + 1);
      const ok = await verifyCredential(tampered, OPEN_MANDATE_TYP, issuer.publicKey).then(
        () => true,
        () => false,
      );
      if (ok) accepted.push(i);
    }
    expect(accepted).toEqual([]);
  });
});

function isLogin(d: string): boolean {
  const parts = JSON.parse(Buffer.from(d, "base64url").toString());
  return parts[1] === "app_login_id";
}
