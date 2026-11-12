import { createHash } from "node:crypto";
import { pack } from "@sd-jwt/core";
import { CompactSign, decodeJwt, decodeProtectedHeader, exportJWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { hSd, mandateChallenge } from "../src/challenge.ts";
import { mandateCommitment } from "../src/commitment.ts";
import {
  issueOpenMandate,
  issueUserCredential,
  OPEN_MANDATE_TYP,
  type OpenMandateVerifyOptions,
  readOpenMandate,
  USER_CREDENTIAL_TYP,
  type UserAuth,
  verifyCredential,
} from "../src/credentials.ts";
import { type Mandate, parseMandate } from "../src/schema.ts";
import { buildSdPayload, withholdPersonal } from "../src/sd.ts";
import {
  checkMandateStatus,
  decodeStatusList,
  encodeStatusList,
  STATUS_LIST_TYP,
  STATUS_SIZE,
  STATUS_URI,
  statusBits,
  statusOf,
} from "../src/status.ts";
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

const AUD = "agt-01";

/** The open mandate for the live mandate, with `zk.commitment` set to the `C_m` that `M` binds. */
async function openMandate() {
  const m = await liveMandate();
  const salt = randomSalt();
  const cm = await mandateCommitment(m, salt);
  m.zk.commitment = `0x${cm.toString(16).padStart(64, "0")}`;
  const { payloadSd, disclosures } = await buildSdPayload(m, randomSalt);
  const challenge = mandateChallenge(hSd(payloadSd), cm);
  const userAuth = await assertion(passkey, challenge);
  const token = await issueOpenMandate(
    { userCredential: l1, payloadSd, disclosures, userAuth, aud: AUD, nonce: m.nonce },
    holder.privateKey,
  );
  const opts: OpenMandateVerifyOptions = {
    expectedAud: AUD,
    expectedNonce: m.nonce,
    now: Math.floor(Date.now() / 1000),
    maxSkewSec: 60,
  };
  return { m, cm, token, payloadSd, disclosures, challenge, userAuth, opts };
}

/** An open mandate over `payloadSd`, which need not be a mandate. */
async function openMandateOver(payloadSd: object, disclosures: string[]): Promise<string> {
  return issueOpenMandate(
    {
      userCredential: l1,
      payloadSd,
      disclosures,
      userAuth: await assertion(passkey, randomSalt()),
      aud: AUD,
      nonce: "n",
    },
    holder.privateKey,
  );
}

/** Re-signs a compact JWS after `edit` changes its payload. */
async function resign(
  jws: string,
  edit: (p: Record<string, unknown>) => void,
  key: CryptoKey,
): Promise<string> {
  const payload = decodeJwt(jws) as Record<string, unknown>;
  edit(payload);
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader(decodeProtectedHeader(jws) as { alg: string })
    .sign(key);
}

const rejects = (token: string, opts: OpenMandateVerifyOptions) =>
  expect(verifyCredential(token, OPEN_MANDATE_TYP, issuer.publicKey, opts)).rejects;

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

  it("makes sub and cred selectively disclosable", async () => {
    const jwt = l1.slice(0, l1.indexOf("~"));
    const signed = decodeJwt(jwt);
    expect(signed.sub).toBeUndefined();
    expect(signed.cred).toBeUndefined();
    expect(l1.split("~").slice(1, -1)).toHaveLength(2);
    const bare = await verifyCredential(`${jwt}~`, USER_CREDENTIAL_TYP, issuer.publicKey);
    expect(bare.claims.sub).toBeUndefined();
    expect(bare.claims.cred).toBeUndefined();
    expect(bare.claims.cnf).toEqual({ jwk: await publicJwk(holder) });
  });

  it("rejects an _sd_alg other than sha-256", async () => {
    const jwt = l1.slice(0, l1.indexOf("~"));
    const forged = await resign(jwt, (p) => (p._sd_alg = "sha-512"), issuer.privateKey);
    for (const token of [`${forged}${l1.slice(jwt.length)}`, `${forged}~`]) {
      await expect(verifyCredential(token, USER_CREDENTIAL_TYP, issuer.publicKey)).rejects.toThrow(
        /sha-512/,
      );
    }
  });

  it("never carries private key material in cnf", async () => {
    const leaky = { ...(await userParams()), holderJwk: await exportJWK(holder.privateKey) };
    const token = await issueUserCredential(leaky as never, issuer.privateKey);
    const v = await verifyCredential(token, USER_CREDENTIAL_TYP, issuer.publicKey);
    expect(v.claims.cnf).toEqual({ jwk: await publicJwk(holder) });
  });

  it("fails with a wrong key or a wrong typ", async () => {
    await expect(verifyCredential(l1, USER_CREDENTIAL_TYP, other.publicKey)).rejects.toThrow();
    const opts = {
      expectedAud: AUD,
      expectedNonce: "n",
      now: Math.floor(Date.now() / 1000),
      maxSkewSec: 0,
    };
    await expect(verifyCredential(l1, OPEN_MANDATE_TYP, issuer.publicKey, opts)).rejects.toThrow();
  });
});

describe("strict input", () => {
  /** The user credential re-signed with `extra` merged into its payload. */
  const issueWith = async (extra: Record<string, unknown>) => {
    const jwt = l1.slice(0, l1.indexOf("~"));
    const forged = await resign(jwt, (p) => Object.assign(p, extra), issuer.privateKey);
    return `${forged}${l1.slice(jwt.length)}`;
  };

  it("rejects a credential carrying a status, without fetching it", async () => {
    for (const status of ["x", { status_list: { idx: 0, uri: "https://127.0.0.1:1/s" } }]) {
      const token = await issueWith({ status });
      await expect(verifyCredential(token, USER_CREDENTIAL_TYP, issuer.publicKey)).rejects.toThrow(
        /status/,
      );
    }
  });

  it("rejects non-integer numbers in a signed payload", async () => {
    const token = await issueWith({ score: 1.5 });
    await expect(verifyCredential(token, USER_CREDENTIAL_TYP, issuer.publicKey)).rejects.toThrow(
      /number/,
    );
  });

  it("rejects holder key coordinates that are not canonical base64url", async () => {
    const jwk = await publicJwk(holder);
    for (const x of [`${jwk.x}=`, ` ${jwk.x}`, `${jwk.x}.`, jwk.x.slice(1), `+${jwk.x.slice(1)}`]) {
      const token = await issueWith({ cnf: { jwk: { ...jwk, x } } });
      await expect(verifyCredential(token, USER_CREDENTIAL_TYP, issuer.publicKey)).rejects.toThrow(
        /cnf/,
      );
    }
  });
  it("rejects holder keys with members other than kty, crv, x, y and kid", async () => {
    const jwk = await publicJwk(holder);
    const kid = await issueWith({ cnf: { jwk: { ...jwk, kid: "holder-1" } } });
    await expect(
      verifyCredential(kid, USER_CREDENTIAL_TYP, issuer.publicKey),
    ).resolves.toBeDefined();
    for (const extra of [
      { key_ops: ["verify"] },
      { key_ops: ["sign"] },
      { ext: true },
      { ext: false },
      { alg: "ES256" },
      { use: "sig" },
      { d: jwk.x },
      { kid: 1 },
    ]) {
      const token = await issueWith({ cnf: { jwk: { ...jwk, ...extra } } });
      await expect(
        verifyCredential(token, USER_CREDENTIAL_TYP, issuer.publicKey),
        JSON.stringify(extra),
      ).rejects.toThrow(/cnf/);
    }
  });
});

describe("open mandate (L2)", () => {
  /** The token with every disclosure whose decoded value satisfies `drop` removed. */
  const without = (token: string, drop: (value: unknown) => boolean) =>
    token
      .split("~")
      .filter(
        (d, i) => i < 3 || d === "" || !drop(JSON.parse(Buffer.from(d, "base64url").toString())[1]),
      )
      .join("~");

  it("rejects a withheld array element, which the schema alone would accept", async () => {
    const { token, opts } = await openMandate();
    const isItem = (v: unknown) => (v as { id?: unknown })?.id === "sku-trail-10";
    await rejects(without(token, isItem), opts).toThrow(/digest/);
  });

  it("rejects a withheld merchant or payee when others remain", async () => {
    const m = await liveMandate();
    for (const c of m.payment.constraints) {
      if (c.type === "payment.allowed_payees") c.allowed.push({ paypal_merchant_id: "MERCH2" });
    }
    for (const c of m.checkout.constraints) {
      if (c.type === "checkout.allowed_merchants") {
        c.allowed.push({
          id: "mrc_two",
          name: "Two",
          website: "https://two.example",
          paypal_merchant_id: "MERCH2",
        });
      }
    }
    const { payloadSd, disclosures } = await buildSdPayload(m, randomSalt);
    const token = await issueOpenMandate(
      {
        userCredential: l1,
        payloadSd,
        disclosures,
        userAuth: await assertion(passkey, randomSalt()),
        aud: AUD,
        nonce: m.nonce,
      },
      holder.privateKey,
    );
    const opts = {
      expectedAud: AUD,
      expectedNonce: m.nonce,
      now: Math.floor(Date.now() / 1000),
      maxSkewSec: 60,
    };
    await verifyCredential(token, OPEN_MANDATE_TYP, issuer.publicKey, opts);
    const merchant = (v: unknown) => (v as { id?: unknown })?.id === "mrc_two";
    const payee = (v: unknown) =>
      (v as { paypal_merchant_id?: unknown })?.paypal_merchant_id === "MERCH2" &&
      Object.keys(v as object).length === 1;
    await rejects(without(token, merchant), opts).toThrow(/digest/);
    await rejects(without(token, payee), opts).toThrow(/digest/);
  });

  it("rejects an unknown expected typ", async () => {
    const { token, opts } = await openMandate();
    await expect(
      verifyCredential(token, "vc+sd-jwt" as typeof OPEN_MANDATE_TYP, issuer.publicKey, opts),
    ).rejects.toThrow(/typ/);
  });

  it("returns the delegate payload as signed", async () => {
    const { token, payloadSd, opts } = await openMandate();
    const v = await verifyCredential(token, OPEN_MANDATE_TYP, issuer.publicKey, opts);
    const payload: Record<string, unknown> = v.payload;
    expect(payload).toEqual(payloadSd);
  });
  it("rejects a delegate_payload that is not an array", async () => {
    const { token, payloadSd, opts } = await openMandate();
    const parts = token.split("~");
    parts[2] = await resign(
      parts[2] as string,
      (p) => {
        p.delegate_payload = { 0: payloadSd, length: 1 };
      },
      holder.privateKey,
    );
    // The delegate payload is now in the clear, so its disclosure is dropped.
    await rejects(parts.toSpliced(3, 1).join("~"), opts).toThrow(/delegate/);
  });

  it("is a kb-sd-jwt+kb chained to L1, carrying the passkey assertion over M", async () => {
    const { m, cm, token, payloadSd, challenge, userAuth, opts } = await openMandate();
    expect(token.startsWith(`${l1.slice(0, l1.indexOf("~"))}~~`)).toBe(true);
    const v = await verifyCredential(token, OPEN_MANDATE_TYP, issuer.publicKey, opts);
    expect(v.header).toMatchObject({ typ: "kb-sd-jwt+kb", alg: "ES256" });
    expect(v.userCredential.claims.cnf).toEqual({ jwk: await publicJwk(holder) });
    expect(v.payload).toEqual(payloadSd);
    expect(v.claims).toEqual({ ...m, cnf: { jwk: m.agent.cnf.jwk } });
    expect(v.mandate).toEqual(m);
    expect(v.userAuth).toEqual(userAuth);

    // A verifier recomputes M from the signed payload and the C_m it carries.
    expect(BigInt(v.mandate.zk.commitment)).toBe(cm);
    expect(mandateChallenge(hSd(v.payload), BigInt(v.mandate.zk.commitment))).toEqual(challenge);
    const clientData = JSON.parse(Buffer.from(v.userAuth.clientDataJSON, "base64url").toString());
    expect(clientData.challenge).toBe(b64u(challenge));
  });

  it("embeds the user credential without sub and cred", async () => {
    const { token, opts } = await openMandate();
    const v = await verifyCredential(token, OPEN_MANDATE_TYP, issuer.publicKey, opts);
    expect(v.userCredential.claims.sub).toBeUndefined();
    expect(v.userCredential.claims.cred).toBeUndefined();
    for (const d of l1.split("~").slice(1, -1)) expect(token).not.toContain(d);
  });

  it("rejects an open mandate with a withheld delegated disclosure", async () => {
    const { token, disclosures, opts } = await openMandate();
    const login = disclosures.find(isLogin);
    await rejects(token.replace(`~${login}~`, "~"), opts).toThrow(/digest/);
  });

  it("accepts a public presentation that withholds only the login id and risk data", async () => {
    const { token, opts } = await openMandate();
    const shown = withholdPersonal(token);
    expect(shown).not.toContain("app_login_id");
    expect(token.split("~").length - shown.split("~").length).toBe(2);
    await rejects(shown, opts).toThrow(/digest/);
    const v = await verifyCredential(shown, OPEN_MANDATE_TYP, issuer.publicKey, {
      ...opts,
      personalWithheld: true,
    });
    expect(v.mandate.user.app_login_id).toBeUndefined();
    expect(v.mandate.risk_data).toBeUndefined();
    expect(v.mandate.user.sub).toBe(demo.user.sub);
    expect(JSON.stringify(v.claims)).not.toContain(demo.user.app_login_id);
    const full = await verifyCredential(token, OPEN_MANDATE_TYP, issuer.publicKey, {
      ...opts,
      personalWithheld: true,
    });
    expect(full.mandate.user.app_login_id).toBe(demo.user.app_login_id);
  });

  it("withholding personal claims still rejects any other withheld disclosure", async () => {
    const { token, opts } = await openMandate();
    const lenient = { ...opts, personalWithheld: true };
    const parts = (t: string) => t.split("~");
    const drop = (t: string, name: string) =>
      parts(t)
        .filter((d, i) => {
          if (i < 3 || d === "" || d.includes(".")) return true;
          return JSON.parse(Buffer.from(d, "base64url").toString())[1] !== name;
        })
        .join("~");
    for (const name of ["sub", "cred", "prompt_summary", "prompt_hash", "max"]) {
      await rejects(drop(withholdPersonal(token), name), lenient).toThrow();
      await rejects(drop(token, name), lenient).toThrow();
    }
    const isItem = (v: unknown) => (v as { id?: unknown })?.id === "sku-trail-10";
    await rejects(without(withholdPersonal(token), isItem), lenient).toThrow(/digest/);
  });

  it("rejects a wrong audience or nonce", async () => {
    const { token, opts } = await openMandate();
    await rejects(token, { ...opts, expectedAud: "agt-02" }).toThrow(/aud/);
    await rejects(token, { ...opts, expectedNonce: "AAAAAAAAAAAAAAAAAAAAAA" }).toThrow(/nonce/);
  });

  it("rejects a key binding iat in the future beyond the skew, and accepts it within", async () => {
    const { token, opts } = await openMandate();
    const parts = token.split("~");
    const withIat = async (iat: number) => {
      const kb = await resign(parts[2] as string, (p) => (p.iat = iat), holder.privateKey);
      return parts.with(2, kb).join("~");
    };
    const skewed = { ...opts, maxSkewSec: 30 };
    await rejects(await withIat(opts.now + 31), skewed).toThrow(/not yet valid/);
    await verifyCredential(
      await withIat(opts.now + 30),
      OPEN_MANDATE_TYP,
      issuer.publicKey,
      skewed,
    );
  });

  it("rejects an expired mandate", async () => {
    const { m, token, opts } = await openMandate();
    const at = (now: number) => ({ ...opts, now, maxSkewSec: 30 });
    await rejects(token, at(m.exp + 30)).toThrow(/expired/);
    await verifyCredential(token, OPEN_MANDATE_TYP, issuer.publicKey, at(m.exp + 29));
  });

  it("rejects a delegate cnf that differs from agent.cnf", async () => {
    const { payloadSd, disclosures, opts } = await openMandate();
    const forged = { ...payloadSd, cnf: { jwk: await publicJwk(other) } };
    await rejects(await openMandateOver(forged, disclosures), {
      ...opts,
      expectedNonce: "n",
    }).toThrow(/cnf/);
  });

  it("rejects a delegate payload that is not a mandate", async () => {
    const { opts } = await openMandate();
    const { packedClaims, disclosures } = await pack(
      { cnf: { jwk: await publicJwk(agent) }, cap: 100 },
      { _sd: ["cap"] },
      { alg: "sha-256", hasher: (d: string | ArrayBuffer) => new Uint8Array(sha256(d as string)) },
      () => b64u(randomSalt()),
    );
    const token = await openMandateOver(
      packedClaims as object,
      disclosures.map((d) => d.encode()),
    );
    await rejects(token, { ...opts, expectedNonce: "n" }).toThrow();
  });

  it("rejects an _sd_alg other than sha-256 in the key binding", async () => {
    const { token, opts } = await openMandate();
    const parts = token.split("~");
    parts[2] = await resign(parts[2] as string, (p) => (p._sd_alg = "sha-512"), holder.privateKey);
    await rejects(parts.join("~"), opts).toThrow(/sha-512/);
  });

  it("fails with a wrong issuer key, a wrong holder key or a wrong typ", async () => {
    const { m, token, payloadSd, disclosures, userAuth, opts } = await openMandate();
    await expect(
      verifyCredential(token, OPEN_MANDATE_TYP, other.publicKey, opts),
    ).rejects.toThrow();
    await expect(verifyCredential(token, USER_CREDENTIAL_TYP, issuer.publicKey)).rejects.toThrow();
    await expect(
      issueOpenMandate(
        { userCredential: l1, payloadSd, disclosures, userAuth, aud: AUD, nonce: m.nonce },
        other.privateKey,
      ),
    ).rejects.toThrow(/cnf.jwk/);
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

  it("fails when a byte of the token changes", async () => {
    const { token, opts } = await openMandate();
    await verifyCredential(token, OPEN_MANDATE_TYP, issuer.publicKey, opts);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const accepted: number[] = [];
    for (const i of tamperPositions(token, 256)) {
      const c = token[i] as string;
      const j = alphabet.indexOf(c);
      const flipped = j < 0 ? "A" : (alphabet[j ^ 1] as string);
      const tampered = token.slice(0, i) + flipped + token.slice(i + 1);
      const ok = await verifyCredential(tampered, OPEN_MANDATE_TYP, issuer.publicKey, opts).then(
        () => true,
        () => false,
      );
      if (ok) accepted.push(i);
    }
    expect(accepted).toEqual([]);
  }, 60_000);
});

/**
 * The positions of `token` worth tampering with: every byte of each JWS header and signature,
 * every separator with the two bytes on each side, every byte that encodes a digest or key in a
 * JWS payload, and a seeded sample of `sample` other payload and disclosure bytes.
 */
function tamperPositions(token: string, sample: number): number[] {
  const all = new Set<number>();
  const rest: number[] = [];
  let at = 0;
  for (const part of token.split("~")) {
    const segments = part.split(".");
    segments.forEach((segment, k) => {
      const end = at + segment.length;
      if (segments.length === 3 && k !== 1) {
        for (let i = at; i < end; i++) all.add(i);
      } else {
        if (segments.length === 3) for (const i of digestBytes(segment)) all.add(at + i);
        for (let i = at; i < end; i++) rest.push(i);
      }
      at = end + 1;
    });
  }
  for (let i = 0; i < token.length; i++) {
    if (token[i] !== "~" && token[i] !== ".") continue;
    for (let j = Math.max(i - 2, 0); j <= Math.min(i + 2, token.length - 1); j++) all.add(j);
  }
  const others = rest.filter((i) => !all.has(i));
  let seed = 0x5eed;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  for (let n = 0; n < Math.min(sample, others.length); n++) {
    const k = n + Math.floor(random() * (others.length - n));
    [others[n], others[k]] = [others[k] as number, others[n] as number];
    all.add(others[n] as number);
  }
  return [...all].sort((a, b) => a - b);
}

/** The base64url characters of a JWS payload that encode its 43-character digests and keys. */
function digestBytes(segment: string): number[] {
  const json = Buffer.from(segment, "base64url").toString("latin1");
  const out: number[] = [];
  for (const m of json.matchAll(/"([A-Za-z0-9_-]{43})"/g)) {
    const start = (m.index as number) + 1;
    const end = Math.min(Math.ceil((start + 43) / 3) * 4, segment.length);
    for (let i = Math.floor(start / 3) * 4; i < end; i++) out.push(i);
  }
  return out;
}

function isLogin(d: string): boolean {
  const parts = JSON.parse(Buffer.from(d, "base64url").toString());
  return parts[1] === "app_login_id";
}

describe("open mandate with decoy digests", () => {
  it("verifies only with its decoy salts", async () => {
    const m = await liveMandate();
    const { payloadSd, disclosures, decoySalts } = await buildSdPayload(m, randomSalt, {
      decoys: true,
    });
    const token = await issueOpenMandate(
      {
        userCredential: l1,
        payloadSd,
        disclosures,
        userAuth: await assertion(passkey, randomSalt()),
        aud: AUD,
        nonce: m.nonce,
      },
      holder.privateKey,
    );
    const opts = {
      expectedAud: AUD,
      expectedNonce: m.nonce,
      now: Math.floor(Date.now() / 1000),
      maxSkewSec: 60,
    };
    const verified = await verifyCredential(token, OPEN_MANDATE_TYP, issuer.publicKey, {
      ...opts,
      decoySalts,
    });
    expect((verified as { mandate: unknown }).mandate).toEqual(m);
    await rejects(token, opts).toThrow(/digest/);
    await rejects(token, {
      ...opts,
      decoySalts: [...decoySalts, "AAAAAAAAAAAAAAAAAAAAAA"],
    }).toThrow("decoy");
    expect(readOpenMandate(token, decoySalts)).toEqual(m);
    // An agent reads its grant without the salts: the decoys are skipped.
    expect(readOpenMandate(token)).toEqual(m);
  });
});

describe("status list", () => {
  const sign = async (lst: string, now: number) =>
    new CompactSign(
      new TextEncoder().encode(
        JSON.stringify({
          sub: STATUS_URI,
          iat: now,
          exp: now + 900,
          ttl: 300,
          status_list: { bits: 1, lst },
        }),
      ),
    )
      .setProtectedHeader({ alg: "ES256", typ: STATUS_LIST_TYP })
      .sign(issuer.privateKey);

  it("a list round-trips and stays under a kilobyte when nothing is revoked", async () => {
    const bits = statusBits([0, 9, STATUS_SIZE - 1]);
    const lst = await encodeStatusList(bits);
    expect(await decodeStatusList(lst)).toEqual(bits);
    expect((await encodeStatusList(statusBits([]))).length).toBeLessThan(1024);
    expect(() => statusBits([STATUS_SIZE])).toThrow("status index");
  });

  it("an open mandate's bit says whether it is revoked", async () => {
    const { token, payloadSd, disclosures, m } = await openMandate();
    const listed = await issueOpenMandate(
      {
        userCredential: l1,
        payloadSd,
        disclosures,
        userAuth: await assertion(passkey, randomSalt()),
        aud: AUD,
        nonce: m.nonce,
        status: { idx: 77, uri: STATUS_URI },
      },
      holder.privateKey,
    );
    expect(statusOf(listed)).toEqual({ idx: 77, uri: STATUS_URI });
    expect(statusOf(token)).toBeNull();
    const now = Math.floor(Date.now() / 1000);
    const valid = await sign(await encodeStatusList(statusBits([76, 78])), now);
    const revoked = await sign(await encodeStatusList(statusBits([77])), now);
    expect(await checkMandateStatus(listed, valid, issuer.publicKey, now)).toBe("valid");
    expect(await checkMandateStatus(listed, revoked, issuer.publicKey, now)).toBe("revoked");
    await expect(checkMandateStatus(listed, revoked, issuer.publicKey, now + 901)).rejects.toThrow(
      "expired",
    );
    await expect(checkMandateStatus(listed, revoked, holder.publicKey, now)).rejects.toThrow();
  });
});
