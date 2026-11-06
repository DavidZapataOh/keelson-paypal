import { createHash } from "node:crypto";
import { decodeJwt, decodeProtectedHeader, exportJWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { hSd, mandateChallenge } from "../src/challenge.ts";
import { mandateCommitment } from "../src/commitment.ts";
import {
  CLOSED_MANDATE_AUD,
  CLOSED_MANDATE_TYP,
  ClosedMandateError,
  type ClosedMandateVerifyOptions,
  closeMandate,
  issueOpenMandate,
  issueUserCredential,
  type P256PublicJwk,
  verifyClosedMandate,
} from "../src/credentials.ts";
import { type Mandate, parseMandate } from "../src/schema.ts";
import { buildSdPayload } from "../src/sd.ts";
import demo from "./fixtures/demo-mandate.json" with { type: "json" };
import vectors from "./vectors/closed-mandate.json" with { type: "json" };

const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const generate = () => crypto.subtle.generateKey(ES256, true, ["sign", "verify"]);
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const randomSalt = () => crypto.getRandomValues(new Uint8Array(16));

const publicJwk = async (k: CryptoKeyPair): Promise<P256PublicJwk> => {
  const { kty, crv, x, y } = await exportJWK(k.publicKey);
  return { kty, crv, x, y } as P256PublicJwk;
};

const REQUEST_ID = "01JC3XQ7ZK8M4N6P9R2T5V7W0Y";
const CART_HASH = `sha256:${"ab".repeat(32)}`;

let issuer: CryptoKeyPair;
let holder: CryptoKeyPair;
let agent: CryptoKeyPair;
let open: string;
let opts: ClosedMandateVerifyOptions;

beforeAll(async () => {
  let passkey: CryptoKeyPair;
  [issuer, holder, passkey, agent] = await Promise.all([
    generate(),
    generate(),
    generate(),
    generate(),
  ]);
  const l1 = await issueUserCredential(
    {
      iss: "https://keelson.finance",
      sub: "kls_usr_7f3a9c21",
      cred: {
        id: "Zk3p0xQmH8vN1sLwT5uYdA",
        rp_id: "keelson.finance",
        jwk: await publicJwk(passkey),
      },
      holderJwk: await publicJwk(holder),
    },
    issuer.privateKey,
  );
  const now = Math.floor(Date.now() / 1000);
  const m = structuredClone(demo) as unknown as Mandate;
  m.iat = now;
  m.nbf = now;
  m.exp = now + 86400;
  m.user.cred.jwk = await publicJwk(passkey);
  m.agent.cnf.jwk = { ...(await publicJwk(agent)), kid: "agt-01" };
  const cm = await mandateCommitment(parseMandate(m), randomSalt());
  m.zk.commitment = `0x${cm.toString(16).padStart(64, "0")}`;
  const { payloadSd, disclosures } = await buildSdPayload(parseMandate(m), randomSalt);
  // The assertion is only checked for shape here; its signature is verified elsewhere.
  const challenge = b64u(mandateChallenge(hSd(payloadSd), cm));
  const userAuth = {
    authenticatorData: b64u(sha256("keelson.finance")),
    clientDataJSON: b64u(Buffer.from(JSON.stringify({ type: "webauthn.get", challenge }))),
    signature: b64u(randomSalt()),
  };
  open = await issueOpenMandate(
    { userCredential: l1, payloadSd, disclosures, userAuth, aud: "agt-01", nonce: m.nonce },
    holder.privateKey,
  );
  opts = {
    open: { expectedAud: "agt-01", expectedNonce: m.nonce, now, maxSkewSec: 60 },
    requestId: REQUEST_ID,
    cartHash: CART_HASH,
  };
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof ClosedMandateError ? e.code : "error";
  }
  return "ok";
};

describe("closed mandate", () => {
  it("appends a kb+jwt signed by the agent key, bound to the request and the cart", async () => {
    const token = await closeMandate(
      open,
      { requestId: REQUEST_ID, cartHash: CART_HASH },
      agent.privateKey,
    );
    expect(token.startsWith(open)).toBe(true);
    const kb = token.slice(open.length);
    expect(decodeProtectedHeader(kb)).toEqual({ typ: CLOSED_MANDATE_TYP, alg: "ES256" });
    const tail = open.slice(open.indexOf("~~") + 2);
    expect(decodeJwt(kb)).toEqual({
      iat: expect.any(Number),
      aud: CLOSED_MANDATE_AUD,
      nonce: REQUEST_ID,
      sd_hash: b64u(sha256(tail)),
      cart_hash: CART_HASH,
    });
    const v = await verifyClosedMandate(token, issuer.publicKey, opts);
    expect(v.agentJwk).toEqual(await publicJwk(agent));
    expect(v.open.mandate.nonce).toBe(opts.open.expectedNonce);
  });

  it("rejects a key binding signed by the holder key instead of the agent key", async () => {
    const token = await closeMandate(
      open,
      { requestId: REQUEST_ID, cartHash: CART_HASH },
      holder.privateKey,
    );
    expect(await code(verifyClosedMandate(token, issuer.publicKey, opts))).toBe("closed_signature");
  });

  it("rejects an open mandate without key binding", async () => {
    expect(await code(verifyClosedMandate(open, issuer.publicKey, opts))).toBe("closed_signature");
  });

  it("rejects another request, another cart or a stale iat", async () => {
    const token = await closeMandate(
      open,
      { requestId: REQUEST_ID, cartHash: CART_HASH, iat: opts.open.now },
      agent.privateKey,
    );
    const verify = (o: Partial<ClosedMandateVerifyOptions>) =>
      code(verifyClosedMandate(token, issuer.publicKey, { ...opts, ...o }));
    expect(await verify({})).toBe("ok");
    expect(await verify({ requestId: "01JC3XQ7ZK8M4N6P9R2T5V7W0Z" })).toBe("closed_nonce");
    expect(await verify({ cartHash: `sha256:${"cd".repeat(32)}` })).toBe("closed_cart_hash");
    expect(await verify({ open: { ...opts.open, now: opts.open.now + 61 } })).toBe("closed_iat");
  });

  it("refuses to close with a malformed request id or cart hash, or an already closed mandate", async () => {
    const close = (o: string, p: { requestId: string; cartHash: string }) =>
      closeMandate(o, p, agent.privateKey);
    await expect(close(open, { requestId: "not-a-ulid", cartHash: CART_HASH })).rejects.toThrow(
      RangeError,
    );
    await expect(
      close(open, { requestId: REQUEST_ID, cartHash: `sha256:${"AB".repeat(32)}` }),
    ).rejects.toThrow(RangeError);
    const closed = await close(open, { requestId: REQUEST_ID, cartHash: CART_HASH });
    await expect(close(closed, { requestId: REQUEST_ID, cartHash: CART_HASH })).rejects.toThrow(
      RangeError,
    );
  });
});

describe("closed-mandate vectors", () => {
  it.each(vectors.map((v) => [v.name, v] as const))("%s", async (_name, v) => {
    const jwk = await crypto.subtle.importKey("jwk", v.input.jwk, ES256, true, ["verify"]);
    const result = await verifyClosedMandate(
      v.input.token,
      jwk,
      v.input.opts as ClosedMandateVerifyOptions,
    ).then(
      (r) => ({ agentJwk: r.agentJwk, iat: r.iat, claims: r.open.claims }),
      (e) => (e instanceof ClosedMandateError ? { error: e.code } : "error"),
    );
    expect(result).toEqual(v.expected);
  });

  it("has a valid vector and an invalid vector for every error code", () => {
    const codes = new Set(
      vectors.map((v) => (v.expected as { error?: string }).error).filter(Boolean),
    );
    expect(codes).toEqual(
      new Set([
        "closed_signature",
        "closed_aud",
        "closed_nonce",
        "closed_cart_hash",
        "closed_sd_hash",
        "closed_iat",
      ]),
    );
    expect(vectors.some((v) => v.name.startsWith("valid"))).toBe(true);
  });
});
