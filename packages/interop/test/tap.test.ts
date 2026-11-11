import { readdirSync, readFileSync } from "node:fs";
import { createSignature, verifySignature } from "http-message-sig";
import { describe, expect, test } from "vitest";
import { verify as webBotAuthVerify } from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";
import { purchaseFacts } from "../src/facts.ts";
import { ExportRefused } from "../src/signer.ts";
import {
  AgentSignatureError,
  type AgentTag,
  ALIBI_HEADER,
  ed25519Signer,
  ed25519Verifier,
  exportTap,
  NonceCache,
  type SignedRequest,
  signAgentRequest,
  TAP_MAX_WINDOW_SECONDS,
  verifyAgentRequest,
  verifyTap,
} from "../src/tap.ts";
import { ALLOW_CARD, ALLOW_PAYPAL, alibi, DENY_PAYPAL, NOW, refFor } from "./fixtures.ts";

const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const B26 = json("./rfc9421-b26.json");
const AGENT = "https://agent.keelson.finance/.well-known/http-message-signatures-directory";

async function freshSigner() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return ed25519Signer(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

/** The rejection code of a verification, or `undefined` when it verifies. */
async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    if (e instanceof AgentSignatureError) return e.code;
    throw e;
  }
}

const descriptor = (r: SignedRequest) => ({
  kind: "request" as const,
  method: r.method,
  targetUri: r.url,
  fields: Object.entries(r.headers).map(([name, value]) => ({ name, value })),
});

describe("RFC 9421 Appendix B.2.6", () => {
  const message = descriptor(B26.request);

  test("the RFC's ed25519 signature verifies with our verifier", async () => {
    const verified = await verifySignature(
      { ...message, fields: [...message.fields, ...signatureFields(B26)] },
      {
        label: B26.label,
        policy: {
          algorithms: ["ed25519"],
          requiredComponents: B26.components,
          requiredParameters: ["created", "keyid"],
          now: B26.created,
        },
        resolveVerifier: () => ed25519Verifier(B26.key),
      },
    );
    expect(verified.parameters.keyid).toBe("test-key-ed25519");
  });

  test("our signer reproduces the RFC's signature byte for byte", async () => {
    const s = await ed25519Signer(B26.key);
    const fields = await createSignature(message, {
      label: B26.label,
      components: B26.components,
      parameters: { created: B26.created, keyid: B26.keyid },
      signer: { algorithm: "ed25519", sign: (d) => sign(s.key, d) },
    });
    expect(fields.signatureInput).toBe(B26.signatureInput);
    expect(fields.signature).toBe(B26.signature);
  });

  test("the signer's kid is the RFC 7638 thumbprint", async () => {
    const s = await ed25519Signer(B26.key);
    expect(s.kid).toBe("poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U");
    expect(s.jwk).toEqual({ kty: "OKP", crv: "Ed25519", x: B26.key.x, kid: s.kid });
  });
});

function signatureFields(v: { signatureInput: string; signature: string }) {
  return [
    { name: "signature-input", value: v.signatureInput },
    { name: "signature", value: v.signature },
  ];
}

async function sign(key: CryptoKey, data: Uint8Array) {
  return new Uint8Array(await crypto.subtle.sign("Ed25519", key, new Uint8Array(data)));
}

interface ArchitectureVector {
  key: { kty: string; crv?: string; x?: string };
  target_url: string;
  created_ms: number;
  label: string;
  signature: string;
  signature_input: string;
  signature_agent?: string;
}

const architecture = (v: number) =>
  (json(`../vendor/web-bot-auth/web_bot_auth_architecture_v${v}.json`) as ArchitectureVector[])
    .map((vector, i) => ({ name: `v${v}[${i}] ${vector.label}`, vector }))
    .filter(({ vector }) => vector.key.kty === "OKP");

const vectorRequest = (v: ArchitectureVector): SignedRequest => ({
  method: "GET",
  url: v.target_url,
  headers: {
    "Signature-Input": v.signature_input,
    Signature: v.signature,
    ...(v.signature_agent ? { "Signature-Agent": v.signature_agent } : {}),
  },
});

describe("Web Bot Auth architecture vectors (cloudflare/web-bot-auth)", () => {
  const cases = [...architecture(1), ...architecture(2)];
  test("covers every Ed25519 case", () => expect(cases.length).toBe(4));

  test.each(cases)(
    "$name verifies with web-bot-auth and with verifyAgentRequest",
    async ({ vector }) => {
      const now = vector.created_ms / 1000 + 60;
      const request = new Request(vector.target_url, { headers: vectorRequest(vector).headers });
      const wba = await verifierFromJWK(vector.key as JsonWebKey);
      await webBotAuthVerify(request, { resolver: () => wba, now: new Date(now * 1000) });
      const out = await verifyAgentRequest(vectorRequest(vector), {
        keys: { keys: [vector.key] },
        now,
        tags: ["web-bot-auth"],
        nonces: new NonceCache(),
      });
      expect(out.tag).toBe("web-bot-auth");
      expect(out.keyid).toBe("poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U");
    },
  );
});

describe("our Web Bot Auth signature", () => {
  test("web-bot-auth@0.2.0 accepts it", async () => {
    const s = await freshSigner();
    const r = await signAgentRequest({ method: "GET", url: "https://shop.example/cart" }, s, {
      tag: "web-bot-auth",
      now: NOW,
      signatureAgent: AGENT,
    });
    const verifier = await verifierFromJWK(s.jwk);
    const verified = await webBotAuthVerify(new Request(r.url, { headers: r.headers }), {
      resolver: (c) => {
        if (c.keyid !== verifier.keyid) throw new Error("unknown key");
        return verifier;
      },
      now: new Date(NOW * 1000),
    });
    expect(verified.keyid).toBe(s.kid);
    expect(verified.signatureAgent?.uri).toBe(AGENT);
    expect(r.headers["signature-agent"]).toBe(`"${AGENT}"`);
  });

  test("the profile: label sig2, ed25519, keyid, 480 s, a 64-byte nonce", async () => {
    const s = await freshSigner();
    const r = await signAgentRequest({ method: "GET", url: "https://shop.example/p?q=1" }, s, {
      tag: "agent-browser-auth",
      now: NOW,
    });
    const input = r.headers["signature-input"] as string;
    expect(input).toMatch(
      new RegExp(
        `^sig2=\\("@authority" "@path"\\);created=${NOW};keyid="${s.kid}";alg="ed25519";expires=${NOW + 480};nonce="[A-Za-z0-9+/]{86}==";tag="agent-browser-auth"$`,
      ),
    );
    expect(Buffer.from(/nonce="([^"]+)"/.exec(input)?.[1] as string, "base64")).toHaveLength(64);
  });
});

describe("TAP policy", () => {
  async function signed(
    tag: AgentTag,
    o: { now?: number; nonce?: string; alibi?: boolean; signatureAgent?: string } = {},
  ) {
    const s = await freshSigner();
    const r = await signAgentRequest({ method: "GET", url: "https://runfast.example/" }, s, {
      tag,
      now: o.now ?? NOW,
      nonce: o.nonce,
      alibi: o.alibi ? refFor(ALLOW_PAYPAL) : undefined,
      signatureAgent: o.signatureAgent,
    });
    return { s, r, keys: { keys: [s.jwk] } };
  }
  const check = (r: SignedRequest, keys: { keys: object[] }, tags: AgentTag[], o = {}) =>
    verifyAgentRequest(r, { keys, now: NOW + 10, tags, nonces: new NonceCache(), ...o });

  test("agent-payer-auth verifies only where the verifier accepts that tag", async () => {
    const { r, keys, s } = await signed("agent-payer-auth");
    expect((await check(r, keys, ["agent-payer-auth"])).keyid).toBe(s.kid);
    expect(await codeOf(check(r, keys, ["agent-browser-auth", "web-bot-auth"]))).toBe("tag");
  });

  test("agent-pay-auth and agent-browser-auth verify under their own tags", async () => {
    for (const tag of ["agent-pay-auth", "agent-browser-auth"] as const) {
      const { r, keys } = await signed(tag);
      expect((await check(r, keys, [tag])).tag).toBe(tag);
    }
  });

  test("a window over 480 seconds is refused", async () => {
    const { r, keys } = await signed("agent-payer-auth");
    const s = await freshSigner();
    const wide = await signWide(s, TAP_MAX_WINDOW_SECONDS + 1);
    expect(await codeOf(check(wide, { keys: [s.jwk] }, ["agent-payer-auth"]))).toBe("window");
    expect(await codeOf(check(r, keys, ["agent-payer-auth"]))).toBeUndefined();
  });

  test("created in the future is a window error; past expires is expired", async () => {
    const { r, keys } = await signed("agent-payer-auth");
    expect(await codeOf(check(r, keys, ["agent-payer-auth"], { now: NOW - 1 }))).toBe("window");
    expect(await codeOf(check(r, keys, ["agent-payer-auth"], { now: NOW + 481 }))).toBe("expired");
  });

  test("the same nonce twice is a replay", async () => {
    const { r, keys } = await signed("agent-payer-auth");
    const nonces = new NonceCache();
    await check(r, keys, ["agent-payer-auth"], { nonces });
    expect(await codeOf(check(r, keys, ["agent-payer-auth"], { nonces }))).toBe("replay");
  });

  test("the keyId spelling is refused", async () => {
    const { r, keys } = await signed("agent-payer-auth");
    const input = (r.headers["signature-input"] as string).replace(";keyid=", ";keyId=");
    const bad = { ...r, headers: { ...r.headers, "signature-input": input } };
    expect(await codeOf(check(bad, keys, ["agent-payer-auth"]))).toBe("keyid");
  });

  test("an unknown key or a changed path fails the signature", async () => {
    const { r, keys } = await signed("agent-payer-auth");
    const other = await freshSigner();
    expect(await codeOf(check(r, { keys: [other.jwk] }, ["agent-payer-auth"]))).toBe("signature");
    const moved = { ...r, url: "https://runfast.example/admin" };
    expect(await codeOf(check(moved, keys, ["agent-payer-auth"]))).toBe("signature");
  });

  test("the alibi header is covered and returned; removing it fails", async () => {
    const { r, keys } = await signed("agent-payer-auth", { alibi: true });
    const ref = refFor(ALLOW_PAYPAL);
    expect(r.headers["signature-input"]).toContain(`"@authority" "@path" "${ALIBI_HEADER}")`);
    expect(r.headers[ALIBI_HEADER]).toBe(
      `leaf=:${Buffer.from(ref.leafHash, "base64url").toString("base64")}:, uri="${ref.uri}"`,
    );
    expect((await check(r, keys, ["agent-payer-auth"])).alibi).toEqual({
      leaf: ref.leafHash,
      uri: ref.uri,
    });
    const { [ALIBI_HEADER]: _, ...rest } = r.headers;
    expect(await codeOf(check({ ...r, headers: rest }, keys, ["agent-payer-auth"]))).toBe(
      "components",
    );
  });

  test("a TAP request without @path is refused", async () => {
    const s = await freshSigner();
    const r = await signWide(s, 300, ["@authority"]);
    expect(await codeOf(check(r, { keys: [s.jwk] }, ["agent-payer-auth"]))).toBe("components");
  });
});

/** A TAP-shaped request signed outside our signer's limits. */
async function signWide(
  s: Awaited<ReturnType<typeof ed25519Signer>>,
  window: number,
  components = ["@authority", "@path"],
): Promise<SignedRequest> {
  const url = "https://runfast.example/";
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("base64");
  const fields = await createSignature(
    { kind: "request", method: "GET", targetUri: url, fields: [] },
    {
      label: "sig2",
      components,
      parameters: {
        created: NOW,
        keyid: s.kid,
        alg: "ed25519",
        expires: NOW + window,
        nonce,
        tag: "agent-payer-auth",
      },
      signer: { algorithm: "ed25519", sign: (d) => sign(s.key, d) },
    },
  );
  return {
    method: "GET",
    url,
    headers: { "signature-input": fields.signatureInput, signature: fields.signature },
  };
}

interface NegativeVector {
  id: string;
  title: string;
  expected: { outcome: "verified" | "invalid" | "unverified" };
  now: number;
  request: SignedRequest & { body?: string };
  directory: { body: string } | null;
}

const negativeDir = new URL("../vendor/webbotauth-negative-vectors/vectors/", import.meta.url);
const negatives = readdirSync(negativeDir)
  .map((f) => JSON.parse(readFileSync(new URL(f, negativeDir), "utf8")) as NegativeVector)
  .filter((v) => v.expected.outcome !== "verified");

/** The rejection each must-reject vector gets, by the vector's stated fault. */
const EXPECTED: Record<string, string> = {
  "NV-01": "components",
  "NV-03": "window",
  "NV-04": "expired",
  "NV-05": "window",
  "NV-06": "signature",
  "NV-07": "signature",
  "NV-08": "signature",
  "NV-09": "components",
  "NV-10": "signature",
  "NV-11": "signature",
  "NV-12": "signature",
  "NV-13": "components",
  "NV-14": "components",
  "NV-16": "components",
  "NV-18": "components",
  "NV-19": "components",
};

describe("Web Bot Auth must-reject vectors (ParallaxGrain)", () => {
  test("covers all sixteen", () =>
    expect(negatives.map((v) => v.id)).toEqual(Object.keys(EXPECTED)));

  test.each(negatives)("$id $title", async (v) => {
    // Without a Signature-Agent there is no directory to take a key from.
    const keys = v.directory ? (JSON.parse(v.directory.body) as { keys: object[] }) : { keys: [] };
    const code = await codeOf(
      verifyAgentRequest(v.request, {
        keys,
        now: v.now,
        tags: ["web-bot-auth"],
        nonces: new NonceCache(),
      }),
    );
    expect(code).toBe(EXPECTED[v.id]);
  });
});

describe("NonceCache", () => {
  test("remembers a nonce for its ttl and forgets it after", () => {
    const c = new NonceCache(480);
    expect(c.seen("n", 1000)).toBe(false);
    expect(c.seen("n", 1479)).toBe(true);
    expect(c.seen("n", 1480 + 480)).toBe(false);
  });
});

describe("exportTap", () => {
  test("a denied purchase gets no payer request", async () => {
    const f = purchaseFacts(alibi(DENY_PAYPAL));
    const p = exportTap(f, refFor(DENY_PAYPAL), { agentHttp: await freshSigner() }, { now: NOW });
    await expect(p).rejects.toThrow(ExportRefused);
    await expect(p).rejects.toMatchObject({ reason: "denied" });
  });

  test("a merchant without a website has no origin to sign for", async () => {
    const f = purchaseFacts(alibi(ALLOW_CARD));
    const p = exportTap(f, refFor(ALLOW_CARD), { agentHttp: await freshSigner() }, { now: NOW });
    await expect(p).rejects.toMatchObject({ reason: "no_merchant_origin" });
  });

  test("without the agent's HTTP key nothing is signed", async () => {
    const f = purchaseFacts(alibi(ALLOW_PAYPAL));
    await expect(exportTap(f, refFor(ALLOW_PAYPAL), {}, { now: NOW })).rejects.toMatchObject({
      reason: "no_http_key",
    });
  });

  test("an allowed PayPal purchase exports a signed payer request that verifies", async () => {
    const f = purchaseFacts(alibi(ALLOW_PAYPAL));
    const ref = refFor(ALLOW_PAYPAL);
    const s = await freshSigner();
    const x = await exportTap(f, ref, { agentHttp: s, signatureAgent: AGENT }, { now: NOW });
    expect(x.type).toBe("keelson.tap/1");
    expect(x.request.method).toBe("GET");
    expect(x.request.url).toBe("https://runfast.example/");
    expect(x.directory).toEqual({ keys: [s.jwk] });
    expect(x.request.headers["signature-input"]).toContain('tag="agent-payer-auth"');

    const report = await verifyTap(x, { now: NOW + 5 });
    expect(report.format).toBe("tap");
    expect(report.checks.map((c) => c.id)).toEqual(["signatures", "tag", "window", "facts"]);
    expect(report.ok).toBe(true);
    const out = await verifyAgentRequest(x.request, {
      keys: x.directory,
      now: NOW + 5,
      tags: ["agent-payer-auth"],
      nonces: new NonceCache(),
    });
    expect(out.alibi?.leaf).toBe(ref.leafHash);
  });

  test("verifyTap fails facts when the export names another statement", async () => {
    const x = await exportTap(
      purchaseFacts(alibi(ALLOW_PAYPAL)),
      refFor(ALLOW_PAYPAL),
      { agentHttp: await freshSigner() },
      { now: NOW },
    );
    const report = await verifyTap({ ...x, alibi: refFor(ALLOW_CARD) }, { now: NOW + 5 });
    expect(report.ok).toBe(false);
    expect(report.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(["facts"]);
    const late = await verifyTap(x, { now: NOW + 481 });
    expect(late.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual([
      "signatures",
      "window",
      "facts",
    ]);
  });
});
