import {
  createSignature,
  isSignatureError,
  type Verifier,
  verifySignature,
  webcrypto,
} from "http-message-sig";
import { base64url, calculateJwkThumbprint, type JWK } from "jose";
import {
  type BareItem,
  type Dictionary,
  isInnerList,
  type Parameters,
  parseDictionary,
  parseItem,
  serializeDictionary,
  serializeItem,
} from "structured-headers";
import type { PurchaseFacts } from "./facts.ts";
import { ExportRefused } from "./signer.ts";
import type { AlibiRef } from "./statement.ts";
import type { CheckId, ExportReport } from "./verify.ts";

/**
 * The signature tags agent requests carry: Visa TAP's browsing and payment tags, Mastercard Agent
 * Pay's tag and Web Bot Auth's.
 */
export type AgentTag =
  | "agent-browser-auth"
  | "agent-payer-auth"
  | "agent-pay-auth"
  | "web-bot-auth";

/** Visa TAP's limit on `expires − created`, and how long its nonces are remembered. */
export const TAP_MAX_WINDOW_SECONDS = 480;

/** The covered header that names the purchase's logged statement. */
export const ALIBI_HEADER = "keelson-alibi";

const LABEL = "sig2";
const ALG = "ed25519";

/** The agent's Ed25519 HTTP signing key, `kid` its RFC 7638 thumbprint. */
export interface Ed25519Signer {
  kid: string;
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string; kid: string };
  key: CryptoKey;
}

/** A request as signed: header names in lower case. */
export interface SignedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** The body, when the signature covers `content-digest`. */
  body?: string;
}

/** Why an agent request signature is refused. */
export class AgentSignatureError extends Error {
  readonly code: "tag" | "window" | "expired" | "replay" | "keyid" | "signature" | "components";

  constructor(code: AgentSignatureError["code"], message: string = code) {
    super(message);
    this.name = "AgentSignatureError";
    this.code = code;
  }
}

/** The nonces seen in the last `ttlSeconds`. */
export class NonceCache {
  readonly #expiry = new Map<string, number>();
  readonly ttlSeconds: number;

  constructor(ttlSeconds: number = TAP_MAX_WINDOW_SECONDS) {
    this.ttlSeconds = ttlSeconds;
  }

  /** Whether `nonce` was seen within the ttl; records it either way. */
  seen(nonce: string, now: number): boolean {
    for (const [n, until] of this.#expiry) if (until <= now) this.#expiry.delete(n);
    const hit = this.#expiry.has(nonce);
    this.#expiry.set(nonce, now + this.ttlSeconds);
    return hit;
  }
}

/** The Ed25519 signer of a private OKP JWK. */
export async function ed25519Signer(privateJwk: JWK): Promise<Ed25519Signer> {
  const { kty, crv, x, d } = privateJwk;
  if (kty !== "OKP" || crv !== "Ed25519" || typeof x !== "string" || typeof d !== "string") {
    throw new RangeError("an Ed25519 private JWK is required");
  }
  const key = await crypto.subtle.importKey("jwk", { kty, crv, x, d }, { name: "Ed25519" }, false, [
    "sign",
  ]);
  const kid = await calculateJwkThumbprint({ kty, crv, x });
  return { kid, jwk: { kty: "OKP", crv: "Ed25519", x, kid }, key };
}

/** An RFC 9421 `ed25519` verifier for a public OKP JWK. */
export async function ed25519Verifier(jwk: { x?: unknown }): Promise<Verifier> {
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: jwk.x as string },
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return webcrypto.verifier(key);
}

const randomNonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(64))));

const alibiHeader = (ref: AlibiRef) =>
  serializeDictionary(
    new Map([
      ["leaf", [base64url.decode(ref.leafHash).slice().buffer, new Map()]],
      ["uri", [ref.uri, new Map()]],
    ]) as Dictionary,
  );

/**
 * Signs a request as RFC 9421 `sig2` over `@authority` and `@path`, plus `Signature-Agent` and
 * the `keelson-alibi` header when given, valid for 480 seconds from `o.now`.
 */
export async function signAgentRequest(
  r: { method: string; url: string },
  s: Ed25519Signer,
  o: {
    tag: AgentTag;
    now: number;
    nonce?: string | undefined;
    alibi?: AlibiRef | undefined;
    signatureAgent?: string | undefined;
  },
): Promise<SignedRequest> {
  if (o.tag === "web-bot-auth" && !o.signatureAgent) {
    throw new RangeError("Web Bot Auth requires a Signature-Agent");
  }
  const headers: Record<string, string> = {};
  const components = ["@authority", "@path"];
  if (o.signatureAgent) {
    headers["signature-agent"] = serializeItem(o.signatureAgent);
    components.push("signature-agent");
  }
  if (o.alibi) {
    headers[ALIBI_HEADER] = alibiHeader(o.alibi);
    components.push(ALIBI_HEADER);
  }
  const fields = await createSignature(
    {
      kind: "request",
      method: r.method,
      targetUri: r.url,
      fields: Object.entries(headers).map(([name, value]) => ({ name, value })),
    },
    {
      label: LABEL,
      components,
      parameters: {
        created: o.now,
        keyid: s.kid,
        alg: ALG,
        expires: o.now + TAP_MAX_WINDOW_SECONDS,
        nonce: o.nonce ?? randomNonce(),
        tag: o.tag,
      },
      signer: webcrypto.signer(s.key),
    },
  );
  headers["signature-input"] = fields.signatureInput;
  headers.signature = fields.signature;
  return { method: r.method, url: r.url, headers };
}

const refuse = (code: AgentSignatureError["code"], message?: string): never => {
  throw new AgentSignatureError(code, message);
};

type Covered = { name: string; params: Parameters };

const bare = (covered: Covered[], name: string) =>
  covered.some((c) => c.name === name && c.params.size === 0);

const httpsUri = (v: BareItem) => typeof v === "string" && URL.parse(v)?.protocol === "https:";

/**
 * Web Bot Auth's `Signature-Agent`: a dictionary whose member the signature covers by `key`, or
 * the single quoted string Cloudflare verifies today, covered bare. Members are https URIs.
 */
function checkSignatureAgent(header: string, covered: Covered[]) {
  const agents = covered.filter((c) => c.name === "signature-agent");
  let dict: Dictionary | undefined;
  try {
    dict = parseDictionary(header);
  } catch {
    let item: BareItem;
    try {
      [item] = parseItem(header);
    } catch {
      return refuse("components", "Signature-Agent is not a structured field");
    }
    if (!httpsUri(item)) refuse("components", "Signature-Agent must be an https URI");
    if (agents.length !== 1 || agents[0]?.params.size !== 0) {
      refuse("components", "the signature must cover Signature-Agent");
    }
    return;
  }
  for (const [, member] of dict) {
    if (isInnerList(member) || !httpsUri(member[0])) {
      refuse("components", "Signature-Agent members must be https URIs");
    }
  }
  const key = agents.length === 1 && agents[0]?.params.size === 1 && agents[0].params.get("key");
  if (typeof key !== "string" || !dict.has(key)) {
    refuse("components", "the signature must cover its own Signature-Agent member");
  }
}

async function findVerifier(keys: object[], keyid: string): Promise<Verifier> {
  for (const k of keys as JWK[]) {
    if (k.kty !== "OKP" || k.crv !== "Ed25519" || typeof k.x !== "string") continue;
    const thumbprint = await calculateJwkThumbprint({ kty: k.kty, crv: k.crv, x: k.x });
    if (k.kid === keyid || thumbprint === keyid) return ed25519Verifier(k);
  }
  return refuse("signature", `no key ${keyid}`);
}

const DIGESTS: Record<string, string> = { "sha-256": "SHA-256", "sha-512": "SHA-512" };

/** RFC 9530: every known digest in `Content-Digest` matches the body. */
async function checkContentDigest(header: string | undefined, body: string | undefined) {
  if (header === undefined || body === undefined) return refuse("signature", "no body to digest");
  let dict: Dictionary;
  try {
    dict = parseDictionary(header);
  } catch {
    return refuse("signature", "Content-Digest is not a dictionary");
  }
  let checked = 0;
  for (const [alg, member] of dict) {
    const hash = DIGESTS[alg];
    if (!hash || isInnerList(member) || !(member[0] instanceof ArrayBuffer)) continue;
    const digest = await crypto.subtle.digest(hash, new TextEncoder().encode(body));
    if (base64url.encode(new Uint8Array(digest)) !== base64url.encode(new Uint8Array(member[0]))) {
      refuse("signature", "Content-Digest does not match the body");
    }
    checked++;
  }
  if (checked === 0) refuse("signature", "Content-Digest has no supported digest");
}

function parseAlibi(header: string | undefined): { leaf: string; uri: string } {
  try {
    const dict = parseDictionary(header ?? "");
    const leaf = dict.get("leaf");
    const uri = dict.get("uri");
    if (leaf && !isInnerList(leaf) && leaf[0] instanceof ArrayBuffer) {
      if (uri && !isInnerList(uri) && typeof uri[0] === "string") {
        return { leaf: base64url.encode(new Uint8Array(leaf[0])), uri: uri[0] };
      }
    }
  } catch {}
  return refuse("components", `${ALIBI_HEADER} is malformed`);
}

const COMPONENT_ERRORS = new Set([
  "MissingField",
  "InvalidComponent",
  "DuplicateComponent",
  "UnsupportedFeature",
]);

/**
 * Verifies an agent request's RFC 9421 signature. Visa TAP and Agent Pay tags need `@authority`,
 * `@path`, a nonce and `expires − created` ≤ 480 s; `web-bot-auth` needs `@authority` or
 * `@target-uri`. A `Signature-Agent` present must be covered. Only the RFC 9421 spelling `keyid`
 * is read.
 */
export async function verifyAgentRequest(
  r: SignedRequest,
  o: { keys: { keys: object[] }; now: number; tags: AgentTag[]; nonces: NonceCache },
): Promise<{ keyid: string; tag: AgentTag; alibi?: { leaf: string; uri: string } }> {
  const fields = Object.entries(r.headers).map(([name, value]) => ({
    name: name.toLowerCase(),
    value,
  }));
  const header = (name: string) => fields.find((f) => f.name === name)?.value;
  const input = header("signature-input");
  if (input === undefined || header("signature") === undefined) {
    return refuse("signature", "the request is not signed");
  }
  if (/[;\s]keyId\s*=/.test(input)) refuse("keyid", "keyId is not RFC 9421's keyid");

  let inputs: Dictionary;
  try {
    inputs = parseDictionary(input);
  } catch {
    return refuse("signature", "Signature-Input is not a dictionary");
  }
  const found = [...inputs].find(
    ([, m]) => isInnerList(m) && o.tags.includes(m[1].get("tag") as AgentTag),
  );
  if (!found) return refuse("tag", `no signature tagged ${o.tags.join(" or ")}`);
  const [label, member] = found;
  const params = member[1];
  const tag = params.get("tag") as AgentTag;
  const tap = tag !== "web-bot-auth";

  const created = params.get("created");
  const expires = params.get("expires");
  if (!Number.isInteger(created) || !Number.isInteger(expires)) {
    refuse("window", "created and expires are required");
  }
  const c = created as number;
  const e = expires as number;
  if (c > e || (tap && e - c > TAP_MAX_WINDOW_SECONDS) || c > o.now) {
    refuse("window", "the signature's window is not valid now");
  }
  if (o.now > e) refuse("expired");

  const keyid = params.get("keyid");
  if (typeof keyid !== "string" || keyid === "") return refuse("keyid", "keyid is required");
  if (params.get("alg") !== ALG) refuse("signature", "alg must be ed25519");
  const nonce = params.get("nonce");
  if (nonce !== undefined && typeof nonce !== "string") refuse("replay", "nonce must be a string");
  if (tap && nonce === undefined) refuse("replay", "nonce is required");

  const covered: Covered[] = (isInnerList(member) ? member[0] : []).map(([name, p]) => ({
    name: String(name),
    params: p,
  }));
  const target = tap
    ? bare(covered, "@authority") && bare(covered, "@path")
    : bare(covered, "@authority") || bare(covered, "@target-uri");
  if (!target) refuse("components", "the signature does not cover the request target");
  const agent = header("signature-agent");
  if (agent !== undefined) checkSignatureAgent(agent, covered);

  const verifier = await findVerifier(o.keys.keys, keyid);
  try {
    await verifySignature(
      { kind: "request", method: r.method, targetUri: r.url, fields },
      {
        label,
        policy: { algorithms: [ALG], requiredComponents: [], requiredParameters: [], now: o.now },
        resolveVerifier: () => verifier,
      },
    );
  } catch (err) {
    if (!isSignatureError(err)) throw err;
    refuse(COMPONENT_ERRORS.has(err.code) ? "components" : "signature", err.message);
  }
  if (covered.some((x) => x.name === "content-digest")) {
    await checkContentDigest(header("content-digest"), r.body);
  }
  if (typeof nonce === "string" && o.nonces.seen(nonce, o.now)) refuse("replay");
  const out: { keyid: string; tag: AgentTag; alibi?: { leaf: string; uri: string } } = {
    keyid,
    tag,
  };
  if (bare(covered, ALIBI_HEADER)) out.alibi = parseAlibi(header(ALIBI_HEADER));
  return out;
}

/** A purchase as a Visa TAP payer request the agent signs, and the key that verifies it. */
export interface TapExport {
  type: "keelson.tap/1";
  request: SignedRequest;
  directory: { keys: object[] };
  alibi: AlibiRef;
}

/**
 * Signs `GET <merchant origin>/` tagged `agent-payer-auth`, covering the `keelson-alibi` header
 * that names the purchase's statement. A denied purchase gets no payer request.
 */
export async function exportTap(
  f: PurchaseFacts,
  ref: AlibiRef,
  k: { agentHttp?: Ed25519Signer; signatureAgent?: string },
  o: { now: number },
): Promise<TapExport> {
  if (f.decision !== "allow") throw new ExportRefused("denied");
  const website = f.merchant.website ? URL.parse(f.merchant.website) : null;
  if (!website) throw new ExportRefused("no_merchant_origin");
  if (!k.agentHttp) throw new ExportRefused("no_http_key");
  const request = await signAgentRequest(
    { method: "GET", url: `${website.origin}/` },
    k.agentHttp,
    { tag: "agent-payer-auth", now: o.now, alibi: ref, signatureAgent: k.signatureAgent },
  );
  return { type: "keelson.tap/1", request, directory: { keys: [k.agentHttp.jwk] }, alibi: ref };
}

/**
 * Verifies a TAP export offline: its signature under one of the trusted agent keys (never a key
 * the export carries), its tag and window, and the header's statement.
 */
export async function verifyTap(
  x: TapExport,
  o: { now: number; agentKeys: object[] },
): Promise<ExportReport> {
  const started = performance.now();
  let code: AgentSignatureError["code"] | undefined;
  let leaf: string | undefined;
  try {
    const out = await verifyAgentRequest(x.request, {
      keys: { keys: o.agentKeys },
      now: o.now,
      tags: ["agent-payer-auth"],
      nonces: new NonceCache(),
    });
    leaf = out.alibi?.leaf;
  } catch (err) {
    if (!(err instanceof AgentSignatureError)) throw err;
    code = err.code;
  }
  const checks: { id: CheckId; ok: boolean; detail?: string }[] = [
    { id: "signatures", ok: code === undefined, ...(code ? { detail: code } : {}) },
    { id: "tag", ok: code !== "tag" },
    { id: "window", ok: code !== "tag" && code !== "window" && code !== "expired" },
    { id: "facts", ok: leaf !== undefined && leaf === x.alibi.leafHash },
  ];
  return { format: "tap", ok: checks.every((c) => c.ok), checks, ms: performance.now() - started };
}
