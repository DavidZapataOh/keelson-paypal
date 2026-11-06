import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@keelson/core";
import { BN254_FR_MODULUS } from "@keelson/core/poseidon2";
import { p256 } from "@noble/curves/nist.js";
import { pack } from "@sd-jwt/core";
import { SDJwtVcInstance } from "@sd-jwt/sd-jwt-vc";
import { hSd, mandateChallenge } from "../src/challenge.ts";
import { fieldColors } from "../src/colors.ts";
import {
  MERCHANT_TREE_CAPACITY,
  mandateCommitment,
  merchantLeaf,
  merchantMembership,
  merchantNonMembership,
  merchantTree,
  type NonMembershipProof,
  userKeyHash,
  verifyMerchantNonMembership,
} from "../src/commitment.ts";
import {
  OPEN_MANDATE_TYP,
  type OpenMandateVerifyOptions,
  type P256PublicJwk,
  USER_CREDENTIAL_TYP,
  USER_CREDENTIAL_VCT,
  type UserAuth,
  type VerifiedCredential,
  type VerifiedOpenMandate,
  verifyCredential,
} from "../src/credentials.ts";
import { type Mandate, parseMandate } from "../src/schema.ts";
import {
  buildSdPayload,
  decodeDisclosed,
  decodeMandate,
  merchantDisclosures,
  sdHasher,
} from "../src/sd.ts";
import demo from "../test/fixtures/demo-mandate.json" with { type: "json" };

const vectorsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../test/vectors");

const encoder = new TextEncoder();
const utf8 = (s: string): Uint8Array<ArrayBuffer> => encoder.encode(s);
const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const b64uJson = (v: unknown): string => b64u(utf8(JSON.stringify(v)));
const field = (n: bigint): string => `0x${n.toString(16).padStart(64, "0")}`;
const hex = (b: Uint8Array): string => `0x${Buffer.from(b).toString("hex")}`;
const clone = <T>(v: T): T => structuredClone(v);

/** Deterministic bytes for the vectors only; the product draws salts and keys from a CSPRNG. */
const seed = (label: string): Uint8Array => sha256(utf8(`keelson/vectors/${label}`));

function salts(label: string): () => Uint8Array {
  let i = 0;
  return () => seed(`salt/${label}/${i++}`).subarray(0, 16);
}

function writeJson(name: string, vectors: unknown): void {
  const path = resolve(vectorsDir, `${name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(vectors, null, 2)}\n`);
}

async function attempt<T>(fn: () => T | Promise<T>): Promise<T | "error"> {
  try {
    return await fn();
  } catch {
    return "error";
  }
}

// ---------------------------------------------------------------------------------------------
// Keys and signatures

interface Key {
  secret: Uint8Array;
  jwk: P256PublicJwk;
  publicKey: CryptoKey;
}

async function key(label: string): Promise<Key> {
  const secret = seed(`key/${label}`);
  const point = p256.getPublicKey(secret, false);
  const jwk: P256PublicJwk = {
    kty: "EC",
    crv: "P-256",
    x: b64u(point.subarray(1, 33)),
    y: b64u(point.subarray(33)),
  };
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
  return { secret, jwk, publicKey };
}

/** Deterministic (RFC 6979) ES256 `r || s` over the JWS signing input. */
const es256 = (k: Key) => (data: string) => b64u(p256.sign(utf8(data), k.secret));

/** A compact JWS whose payload is the given JSON text, which may be outside what `JSON.stringify` writes. */
function jwsRaw(header: object, payload: string, k: Key): string {
  const input = `${b64uJson(header)}.${b64u(utf8(payload))}`;
  return `${input}.${es256(k)(input)}`;
}

const jws = (header: object, payload: unknown, k: Key): string =>
  jwsRaw(header, JSON.stringify(payload), k);

/** `n` nested arrays, nesting `n` levels deep. */
const nest = (n: number): string => "[".repeat(n) + "]".repeat(n);

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** The same signature with `s` replaced by `n - s`, which ECDSA also accepts. */
function highS(token: string): string {
  const i = token.lastIndexOf(".");
  const sig = Buffer.from(token.slice(i + 1), "base64url");
  const s = BigInt(`0x${sig.subarray(32).toString("hex")}`);
  const flipped = Buffer.from((P256_N - s).toString(16).padStart(64, "0"), "hex");
  return `${token.slice(0, i + 1)}${b64u(Buffer.concat([sig.subarray(0, 32), flipped]))}`;
}

const decodePart = (jwt: string, i: number): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split(".")[i] as string, "base64url").toString("utf8"));

function disclosure(value: unknown[]): { encoded: string; digest: string } {
  const encoded = b64uJson(value);
  return { encoded, digest: b64u(sdHasher(encoded, "sha-256")) };
}

// ---------------------------------------------------------------------------------------------
// Mandates

type Merchant = Extract<
  Mandate["checkout"]["constraints"][number],
  { type: "checkout.allowed_merchants" }
>["allowed"][number];

const mandate = (): Mandate => parseMandate(clone(demo));

/** A mandate whose merchants have non-BMP names and whose amounts are 2^53 - 1. */
function edgeMandate(): Mandate {
  const m = mandate();
  for (const c of m.payment.constraints) {
    if (c.type === "payment.amount_range" || c.type === "payment.budget") {
      c.max = Number.MAX_SAFE_INTEGER;
    }
    if (c.type === "payment.allowed_payees") c.allowed.push({ paypal_merchant_id: "MERCH😀2" });
  }
  for (const c of m.checkout.constraints) {
    if (c.type === "checkout.allowed_merchants") {
      c.allowed.push({
        id: "mrc_𝄞_東京_😀",
        name: "Café 𝄞 東京 😀",
        website: "https://xn--caf-dma.example",
        paypal_merchant_id: "MERCH😀2",
      });
    }
  }
  m.agent.bond.min = Number.MAX_SAFE_INTEGER;
  return parseMandate(m);
}

// ---------------------------------------------------------------------------------------------
// Selective disclosure and the challenge

const decodeDisclosure = (d: string): unknown[] =>
  JSON.parse(Buffer.from(d, "base64url").toString("utf8"));

async function sdVectors() {
  const vectors: { name: string; input: unknown; expected: unknown }[] = [];
  const add = async (name: string, payloadSd: object, disclosures: string[]) => {
    vectors.push({
      name,
      input: { payloadSd, disclosures },
      expected: await attempt(() => decodeDisclosed(clone(payloadSd), disclosures)),
    });
  };

  const demoSd = await buildSdPayload(mandate(), salts("sd/demo"));
  const { payloadSd, disclosures } = demoSd;
  await add("demo/all", payloadSd, disclosures);
  await add("demo/none", payloadSd, []);
  await add("demo/reversed", payloadSd, [...disclosures].reverse());
  for (const [i, d] of disclosures.entries()) {
    const label = JSON.stringify(decodeDisclosure(d)[1]).slice(0, 24);
    await add(`demo/only-${i}-${label}`, payloadSd, [d]);
    await add(
      `demo/without-${i}-${label}`,
      payloadSd,
      disclosures.filter((_, j) => j !== i),
    );
  }
  await add(
    "demo/merchant-view",
    payloadSd,
    merchantDisclosures(disclosures, { merchant: "mrc_runfast", items: ["sku-trail-10"] }),
  );
  await add(
    "demo/merchant-view-with-cap",
    payloadSd,
    merchantDisclosures(disclosures, { merchant: "mrc_runfast", cap: true }),
  );

  const edge = await buildSdPayload(edgeMandate(), salts("sd/edge"));
  await add("edge/all", edge.payloadSd, edge.disclosures);
  await add(
    "edge/merchant-view-non-bmp",
    edge.payloadSd,
    merchantDisclosures(edge.disclosures, { merchant: "mrc_𝄞_東京_😀", cap: true }),
  );

  const withAlg = (alg: unknown) => ({ ...payloadSd, _sd_alg: alg });
  await add("sd-alg/sha-256", withAlg("sha-256"), disclosures);
  for (const alg of ["sha-512", "SHA-256", "sha-384", "", 256]) {
    await add(`error/sd-alg-${alg}`, withAlg(alg), disclosures);
  }

  const other = await buildSdPayload(mandate(), salts("sd/other"));
  await add("error/duplicate-disclosure", payloadSd, [...disclosures, disclosures[0] as string]);
  await add("error/unreferenced-disclosure", payloadSd, [
    ...disclosures,
    other.disclosures[0] as string,
  ]);
  await add("error/cnf-differs", { ...payloadSd, cnf: { jwk: mandate().user.cred.jwk } }, [
    ...disclosures,
  ]);
  await add(
    "error/cnf-missing",
    (({ cnf: _, ...rest }) => rest)(payloadSd as Record<string, unknown>),
    [...disclosures],
  );
  await add("error/not-base64url", payloadSd, [...disclosures, "not base64url!"]);
  await add("error/not-json", payloadSd, [...disclosures, b64u(utf8('["a",'))]);

  const salt = (i: number) => b64u(seed(`salt/sd/crafted/${i}`).subarray(0, 16));
  /** `payloadSd` with extra digests in `user._sd`, and the extra disclosures appended. */
  const inUser = async (name: string, extra: unknown[][], digests?: string[]) => {
    const p = clone(payloadSd) as { user: { _sd: string[] } };
    const ds = extra.map(disclosure);
    p.user._sd.push(...(digests ?? ds.map((d) => d.digest)));
    await add(name, p, [...disclosures, ...ds.map((d) => d.encoded)]);
  };
  await inUser("crafted/extra-claim", [[salt(0), "nickname", "andres"]]);
  await inUser("crafted/empty-claim-name", [[salt(1), "", 1]]);
  await inUser("error/reserved-name-sd", [[salt(2), "_sd", ["x"]]]);
  await inUser("error/reserved-name-ellipsis", [[salt(3), "...", "x"]]);
  await inUser("error/colliding-with-payload", [[salt(4), "sub", "kls_usr_other"]], undefined);
  await inUser("error/colliding-disclosures", [
    [salt(5), "nickname", "a"],
    [salt(6), "nickname", "b"],
  ]);
  await inUser("error/prototype-name", [[salt(7), "toString", "x"]]);
  await inUser("error/array-disclosure-as-claim", [[salt(8), "x"]]);
  await inUser("error/four-elements", [[salt(9), "a", "b", "c"]]);
  await inUser("error/salt-not-string", [[9, "a", "b"]]);
  await inUser("error/claim-name-not-string", [[salt(10), 7, "b"]]);
  await inUser("error/nested-sd-alg", [[salt(11), "nested", { _sd_alg: "sha-256" }]]);
  await inUser(
    "error/digest-repeated",
    [[salt(12), "nickname", "a"]],
    [
      disclosure([salt(12), "nickname", "a"]).digest,
      disclosure([salt(12), "nickname", "a"]).digest,
    ],
  );
  await inUser("crafted/decoy-digest", [], [b64u(seed("decoy").subarray(0, 32))]);
  await inUser("error/digest-is-prototype-name", [], ["constructor"]);

  /** `payloadSd` with an extra array placeholder in `intent.subjective`. */
  const inArray = async (name: string, placeholder: unknown, extra: unknown[][]) => {
    const p = clone(payloadSd) as { intent: { subjective: unknown[] } };
    p.intent.subjective.push(placeholder);
    await add(name, p, [...disclosures, ...extra.map((e) => disclosure(e).encoded)]);
  };
  const element = [salt(20), { nested: ["a", 1, null] }];
  await inArray("crafted/array-element", { "...": disclosure(element).digest }, [element]);
  await inArray("crafted/array-element-undisclosed", { "...": disclosure(element).digest }, []);
  const claim = [salt(21), "k", "v"];
  await inArray("error/claim-disclosure-as-element", { "...": disclosure(claim).digest }, [claim]);
  await inArray("error/placeholder-with-extra-key", { "...": disclosure(element).digest, a: 1 }, [
    element,
  ]);
  await inArray("error/placeholder-not-string", { "...": 1 }, []);
  await inArray("error/placeholder-prototype-name", { "...": "toString" }, []);

  /** `payloadSd` with one top-level disclosure given as raw JSON text. */
  const raw = async (name: string, json: string) => {
    const encoded = b64u(utf8(json));
    const p = clone(payloadSd) as { _sd: string[] };
    p._sd.push(b64u(sdHasher(encoded, "sha-256")));
    await add(name, p, [...disclosures, encoded]);
  };
  for (const n of ["9007199254740991", "-9007199254740991", "0", "-1"]) {
    await raw(`number/${n}`, `["${salt(30)}","n",${n}]`);
  }
  for (const n of [
    "1.0",
    "-0",
    "-0.0",
    "1e2",
    "1E2",
    "1e400",
    "1.5",
    "9007199254740992",
    "9007199254740993",
    "-9007199254740992",
  ]) {
    await raw(`error/number-${n}`, `["${salt(30)}","n",${n}]`);
  }
  await raw("error/lone-surrogate-value", `["${salt(31)}","n","\\ud800"]`);
  await raw("error/lone-surrogate-name", `["${salt(31)}","\\udc00",1]`);
  await raw("error/lone-surrogate-nested-key", `["${salt(31)}","n",{"\\ud800x":1}]`);
  await raw("surrogate-pair", `["${salt(31)}","n","\\ud83d\\ude00"]`);
  await raw("depth/disclosure-32", `["${salt(32)}","n",${nest(31)}]`);
  await raw("error/depth/disclosure-33", `["${salt(32)}","n",${nest(32)}]`);
  await add("depth/payload-32", { ...payloadSd, deep: JSON.parse(nest(31)) }, disclosures);
  await add("error/depth/payload-33", { ...payloadSd, deep: JSON.parse(nest(32)) }, disclosures);
  await add("error/payload-number-fraction", { ...payloadSd, n: 1.5 }, disclosures);
  await add("error/payload-number-unsafe", { ...payloadSd, n: 2 ** 53 }, disclosures);
  /** A chain of `n` disclosures, each the only claim of the previous one's value. */
  const chain = async (name: string, n: number) => {
    let value: object = {};
    const encoded: string[] = [];
    for (let i = 0; i < n; i++) {
      const d = disclosure([salt(100 + i), "c", value]);
      encoded.push(d.encoded);
      value = { _sd: [d.digest] };
    }
    const p = clone(payloadSd) as { _sd: string[] };
    p._sd.push(...(value as { _sd: string[] })._sd);
    await add(name, p, [...disclosures, ...encoded]);
  };
  await chain("depth/chain-32", 31);
  await chain("error/depth/chain-33", 32);

  const badSd = clone(payloadSd) as { user: { _sd: unknown } };
  badSd.user._sd = "not-an-array";
  await add("error/sd-not-array", badSd, disclosures);
  await add("error/payload-not-object", [] as unknown as object, []);

  /** Full decoding: every digest must be resolved and the result must parse as a mandate. */
  const full = async (name: string, payload: object, ds: string[]) => {
    vectors.push({
      name: `decodeMandate/${name}`,
      input: { op: "decodeMandate", payloadSd: payload, disclosures: ds },
      expected: await attempt(() => decodeMandate(clone(payload), ds)),
    });
  };
  await full("demo", payloadSd, disclosures);
  await full("edge", edge.payloadSd, edge.disclosures);
  for (const [i, d] of disclosures.entries()) {
    await full(
      `error/without-${i}`,
      payloadSd,
      disclosures.filter((x) => x !== d),
    );
  }
  for (const [label, test] of [
    ["merchant", (v: Record<string, unknown>) => v.id === "mrc_𝄞_東京_😀"],
    ["payee", (v: Record<string, unknown>) => v.paypal_merchant_id === "MERCH😀2" && !("id" in v)],
  ] as const) {
    const kept = edge.disclosures.filter((d) => {
      const v = decodeDisclosure(d).at(-1);
      return !(v !== null && typeof v === "object" && test(v as Record<string, unknown>));
    });
    await full(`error/edge-without-${label}`, edge.payloadSd, kept);
  }
  await full(
    "error/decoy-digest",
    { ...payloadSd, _sd: [...(payloadSd as { _sd: string[] })._sd, b64u(seed("decoy"))] },
    disclosures,
  );
  return vectors;
}

async function challengeVectors() {
  const vectors: { name: string; input: unknown; expected: string }[] = [];
  const demoSd = await buildSdPayload(mandate(), salts("sd/demo"));
  const edgeSd = await buildSdPayload(edgeMandate(), salts("sd/edge"));
  for (const [name, p] of [
    ["demo", demoSd.payloadSd],
    ["edge", edgeSd.payloadSd],
  ] as const) {
    vectors.push({
      name: `hSd/${name}`,
      input: { op: "hSd", payloadSd: p },
      expected: hex(hSd(p)),
    });
  }
  const cm = await mandateCommitment(mandate(), seed("salt/commitment/demo").subarray(0, 16));
  const h = hSd(demoSd.payloadSd);
  const cases: [string, Uint8Array, bigint][] = [
    ["demo", h, cm],
    ["zero", new Uint8Array(32), 0n],
    ["one", h, 1n],
    ["max", new Uint8Array(32).fill(0xff), BN254_FR_MODULUS - 1n],
  ];
  for (const [name, hSdBytes, c] of cases) {
    vectors.push({
      name: `challenge/${name}`,
      input: { op: "mandateChallenge", hSd: hex(hSdBytes), cm: field(c) },
      expected: hex(mandateChallenge(hSdBytes, c)),
    });
  }
  return vectors;
}

// ---------------------------------------------------------------------------------------------
// Commitment

async function commitmentVectors() {
  const vectors: { name: string; input: unknown; expected: unknown }[] = [];
  const push = (name: string, input: unknown, expected: unknown) =>
    vectors.push({ name, input, expected });
  const fieldOr = (v: bigint | "error") => (v === "error" ? v : field(v));

  const ids = [
    "mrc_runfast",
    "a",
    "x".repeat(31),
    "y".repeat(32),
    "z".repeat(100),
    "Café Ñandú",
    "東京の店",
    "😀",
    "mrc_𝄞_東京_😀",
    "",
    "nul\0inside",
  ];
  for (const id of ids) {
    push(
      `merchantLeaf/${JSON.stringify(id)}`,
      { op: "merchantLeaf", id },
      fieldOr(await attempt(() => merchantLeaf(id))),
    );
  }
  // Lone surrogates cannot appear in JSON vectors that a strict parser reads, so these carry
  // the id as UTF-16 code units.
  for (const units of [[0x61, 0xd800], [0xdc00], [0xd800, 0x61], [0xd83d, 0xde00]]) {
    const id = String.fromCharCode(...units);
    push(
      `merchantLeaf/utf16-${units.map((u) => u.toString(16)).join("-")}`,
      { op: "merchantLeaf", utf16: units },
      fieldOr(await attempt(() => merchantLeaf(id))),
    );
  }

  const many = (n: number) => Array.from({ length: n }, (_, i) => `mrc_${i}`);
  const sets: [string, string[]][] = [
    ["single", ["mrc_runfast"]],
    ["unsorted", ["mrc_zeta", "mrc_alpha", "mrc_mid", "😀", "東京の店"]],
    ["non-bmp", ["mrc_𝄞_東京_😀", "😀😀😀"]],
    ["capacity", many(MERCHANT_TREE_CAPACITY)],
    ["error/over-capacity", many(MERCHANT_TREE_CAPACITY + 1)],
    ["error/duplicate", ["mrc_a", "mrc_b", "mrc_a"]],
    ["error/empty", []],
    ["error/empty-id", ["mrc_a", ""]],
  ];
  for (const [name, set] of sets) {
    push(
      `merchantRoot/${name}`,
      { op: "merchantRoot", ids: set },
      fieldOr(await attempt(async () => (await merchantTree(set)).root)),
    );
  }

  const proofJson = (
    p: { path: bigint[]; index: number },
    leaf: { value: bigint; next: bigint; nextIndex: number },
  ) => ({
    leaf: { value: field(leaf.value), next: field(leaf.next), nextIndex: leaf.nextIndex },
    path: p.path.map(field),
    index: p.index,
  });
  const treeIds = ["mrc_zeta", "mrc_alpha", "mrc_mid", "😀", "東京の店"];
  const tree = await merchantTree(treeIds);
  for (const id of [...treeIds, "mrc_absent", "mrc_𝄞"]) {
    const member = await attempt(() => merchantMembership(tree, id));
    push(
      `membership/${id}`,
      { op: "membership", ids: treeIds, id },
      member === "error" ? member : proofJson(member, member.leaf),
    );
    const non = await attempt(() => merchantNonMembership(tree, id));
    push(
      `nonMembership/${id}`,
      { op: "nonMembership", ids: treeIds, id },
      non === "error" ? non : proofJson(non, non.low),
    );
  }
  /** The first `probe-i` id whose leaf is below the smallest or above the largest of `t`. */
  const probe = async (t: { leaves: bigint[] }, below: boolean) => {
    const [min, max] = [t.leaves[0] as bigint, t.leaves.at(-1) as bigint];
    for (let i = 0; ; i++) {
      const v = await merchantLeaf(`probe-${i}`);
      if (below ? v < min : v > max) return `probe-${i}`;
    }
  };
  const full = many(MERCHANT_TREE_CAPACITY);
  const fullTree = await merchantTree(full);
  const lastId = full[
    (await Promise.all(full.map(merchantLeaf))).indexOf(fullTree.leaves.at(-1) as bigint)
  ] as string;
  const edges: [string, string[], string][] = [
    ["low-leaf-zero", treeIds, await probe(tree, true)],
    ["low-leaf-last", treeIds, await probe(tree, false)],
    ["full/below", full, await probe(fullTree, true)],
    ["full/above", full, await probe(fullTree, false)],
    ["full/last-slot", full, lastId],
  ];
  for (const [name, set, id] of edges) {
    const t = set === full ? fullTree : tree;
    const member = await attempt(() => merchantMembership(t, id));
    push(
      `membership/edge/${name}`,
      { op: "membership", ids: set, id },
      member === "error" ? member : proofJson(member, member.leaf),
    );
    const non = await attempt(() => merchantNonMembership(t, id));
    push(
      `nonMembership/edge/${name}`,
      { op: "nonMembership", ids: set, id },
      non === "error" ? non : proofJson(non, non.low),
    );
  }
  push(
    "merchantRoot/error/full-plus-one",
    { op: "merchantRoot", ids: [...full, `${lastId}x`] },
    fieldOr(await attempt(async () => (await merchantTree([...full, `${lastId}x`])).root)),
  );

  const absent = await merchantNonMembership(tree, "mrc_absent");
  const empty = { value: 0n, next: 0n, nextIndex: 0 };
  const pathAt = (index: number) =>
    tree.layers.slice(0, 8).map((layer, h) => layer[(index >> h) ^ 1] as bigint);
  const forged: [string, NonMembershipProof][] = [
    ["empty-low-leaf", { low: empty, path: pathAt(200), index: 200 }],
    ["genuine", absent],
    ["wrong-index", { ...absent, index: absent.index + 1 }],
  ];
  for (const [name, proof] of forged) {
    push(
      `verifyNonMembership/${name}`,
      {
        op: "verifyNonMembership",
        root: field(tree.root),
        id: "mrc_absent",
        proof: proofJson(proof, proof.low),
      },
      await verifyMerchantNonMembership(tree.root, "mrc_absent", proof),
    );
  }

  const coordinate = (fill: number) => b64u(new Uint8Array(32).fill(fill));
  const keys: [string, { x: string; y: string }][] = [
    ["demo", demo.user.cred.jwk],
    ["zero", { x: coordinate(0), y: coordinate(0) }],
    ["max", { x: coordinate(0xff), y: coordinate(0x80) }],
    ["error/non-canonical", { x: `${coordinate(0).slice(0, 42)}B`, y: coordinate(0) }],
    ["error/short", { x: coordinate(0).slice(1), y: coordinate(0) }],
  ];
  for (const [name, jwk] of keys) {
    push(
      `userKeyHash/${name}`,
      { op: "userKeyHash", jwk },
      fieldOr(await attempt(() => userKeyHash(jwk))),
    );
  }

  const salt = seed("salt/commitment/demo").subarray(0, 16);
  const variants: [string, (m: Mandate) => void][] = [
    ["demo", () => {}],
    ["edge", () => {}],
    ["operator-p-minus-1", (m) => (m.agent.operator.agent_id = (BN254_FR_MODULUS - 1n).toString())],
    ["error/operator-p", (m) => (m.agent.operator.agent_id = BN254_FR_MODULUS.toString())],
    ["error/operator-not-decimal", (m) => (m.agent.operator.agent_id = "agent-7")],
    ["error/operator-leading-zero", (m) => (m.agent.operator.agent_id = "042")],
    [
      "no-category",
      (m) => {
        m.checkout.constraints = m.checkout.constraints.filter(
          (c) => c.type !== "keelson.category",
        );
      },
    ],
    [
      "category-deny",
      (m) => {
        for (const c of m.checkout.constraints) {
          if (c.type === "keelson.category") {
            c.allow = ["gpt:166", "gpt:187", "gpt:1"];
            c.deny = ["gpt:187"];
          }
        }
      },
    ],
    [
      "error/unknown-category",
      (m) => {
        for (const c of m.checkout.constraints)
          if (c.type === "keelson.category") c.allow = ["gpt:999999"];
      },
    ],
    [
      "jpy",
      (m) => {
        m.payment.currency = "JPY";
        for (const c of m.payment.constraints) if ("currency" in c) c.currency = "JPY";
      },
    ],
    [
      "error/currency-mismatch",
      (m) => {
        for (const c of m.payment.constraints) if (c.type === "payment.budget") c.currency = "EUR";
      },
    ],
    ["error/extra-key", (m) => Object.assign(m, { extra: 1 })],
    [
      "error/missing-amount-range",
      (m) => {
        m.payment.constraints = m.payment.constraints.filter(
          (c) => c.type !== "payment.amount_range",
        );
      },
    ],
    ["error/lifetime", (m) => (m.exp = m.iat + 30 * 86400 + 1)],
    ["lifetime-max", (m) => (m.exp = m.iat + 30 * 86400)],
    ["error/nbf-before-iat", (m) => (m.nbf = m.iat - 1)],
    [
      "error/amount-unsafe",
      (m) => {
        for (const c of m.payment.constraints)
          if (c.type === "payment.amount_range") c.max = 2 ** 53;
      },
    ],
    [
      "error/amount-fraction",
      (m) => {
        for (const c of m.payment.constraints) if (c.type === "payment.amount_range") c.max = 1.5;
      },
    ],
    ["error/nonce-non-canonical", (m) => (m.nonce = "q83vE1n2k0Zr7yT4aB9cDh")],
    ["error/nonce-non-ascii", (m) => (m.nonce = `${"A".repeat(20)}é`)],
    ["error/jwk-x-non-ascii", (m) => (m.user.cred.jwk.x = `${"A".repeat(41)}é`)],
    [
      "datetime-long-fraction",
      (m) => {
        for (const c of m.payment.constraints)
          if (c.type === "payment.execution_date")
            c.not_after = "2026-11-13T23:59:59.123456789012Z";
      },
    ],
    ["error/bad-ulid", (m) => (m.mid = "81JBXG3K5N7Q9R2T4V6W8Y0Z1A")],
    [
      "error/bad-website",
      (m) => {
        for (const c of m.checkout.constraints) {
          if (c.type === "checkout.allowed_merchants")
            (c.allowed[0] as { website: string }).website = "not a url";
        }
      },
    ],
    [
      "error/bad-datetime",
      (m) => {
        for (const c of m.payment.constraints)
          if (c.type === "payment.execution_date") c.not_after = "2026-02-30T00:00:00Z";
      },
    ],
    ["error/bad-prompt-hash", (m) => (m.intent.prompt_hash = "sha256:XYZ")],
    [
      "error/duplicate-merchant",
      (m) => {
        for (const c of m.checkout.constraints) {
          if (c.type === "checkout.allowed_merchants") c.allowed.push(clone(c.allowed[0] as never));
        }
      },
    ],
    [
      "error/title-null",
      (m) => {
        for (const c of m.checkout.constraints) {
          if (c.type === "checkout.line_items")
            (c.items[0]?.acceptable_items[0] as { title: unknown }).title = null;
        }
      },
    ],
    [
      "no-title",
      (m) => {
        for (const c of m.checkout.constraints) {
          if (c.type === "checkout.line_items") delete c.items[0]?.acceptable_items[0]?.title;
        }
      },
    ],
  ];
  for (const [name, edit] of variants) {
    const m = name === "edge" ? edgeMandate() : (clone(demo) as unknown as Mandate);
    edit(m);
    push(
      `mandateCommitment/${name}`,
      { op: "mandateCommitment", mandate: m, salt: hex(salt) },
      fieldOr(await attempt(() => mandateCommitment(clone(m), salt))),
    );
  }
  const merchants = (m: Mandate, edit: (x: Merchant) => void) => {
    for (const c of m.checkout.constraints)
      if (c.type === "checkout.allowed_merchants") c.allowed.forEach(edit);
  };
  const attributes = (m: Mandate, must: Record<string, string>) => {
    for (const c of m.checkout.constraints) if (c.type === "keelson.attributes") c.must = must;
  };
  const parseCases: [string, (m: Mandate) => void][] = [
    ["demo", () => {}],
    [
      "error/unknown-allow-category",
      (m) => {
        for (const c of m.checkout.constraints)
          if (c.type === "keelson.category") c.allow.push("gpt:999999");
      },
    ],
    [
      "error/unknown-deny-category",
      (m) => {
        for (const c of m.checkout.constraints)
          if (c.type === "keelson.category") c.deny = ["nope"];
      },
    ],
    [
      "error/no-acceptable-items",
      (m) => {
        for (const c of m.checkout.constraints) {
          if (c.type === "checkout.line_items")
            (c.items[0] as { acceptable_items: unknown[] }).acceptable_items = [];
        }
      },
    ],
    [
      "error/bidi-override-in-merchant-name",
      (m) => merchants(m, (x) => (x.name = "Run\u202eFast")),
    ],
    ["error/newline-in-merchant-name", (m) => merchants(m, (x) => (x.name = "Run\nFast"))],
    ["error/zero-width-in-merchant-id", (m) => merchants(m, (x) => (x.id = "mrc\u200b_runfast"))],
    ["error/bom-in-subjective", (m) => (m.intent.subjective = ["look\ufeff good"])],
    ["error/c1-control-in-prompt-summary", (m) => (m.intent.prompt_summary = "buy\u0085shoes")],
    ["error/tag-character-in-attribute-value", (m) => attributes(m, { size_us: "10\u{e0041}" })],
    ["error/format-character-in-attribute-key", (m) => attributes(m, { "size\u2066_us": "10" })],
    ["error/astral-format-character", (m) => merchants(m, (x) => (x.name = "Run\u{110bd}Fast"))],
    [
      "ok/non-format-space-and-astral-text",
      (m) => merchants(m, (x) => (x.name = "Run\u2009Fast \u{1f45f}")),
    ],
    ["ok/name-at-byte-limit", (m) => merchants(m, (x) => (x.name = "\u{1f45f}".repeat(32)))],
    [
      "error/name-over-byte-limit",
      (m) => merchants(m, (x) => (x.name = `${"\u{1f45f}".repeat(32)}a`)),
    ],
    [
      "error/website-over-limit",
      (m) => merchants(m, (x) => (x.website = `https://a.example/${"p".repeat(2040)}`)),
    ],
    ["error/summary-over-limit", (m) => (m.intent.prompt_summary = "a".repeat(1025))],
    ["ok/summary-at-limit", (m) => (m.intent.prompt_summary = "a".repeat(1024))],
    ["error/subjective-over-limit", (m) => (m.intent.subjective = ["a".repeat(257)])],
  ];
  for (const [name, edit] of parseCases) {
    const m = clone(demo) as unknown as Mandate;
    edit(m);
    push(
      `parseMandate/${name}`,
      { op: "parseMandate", mandate: m },
      await attempt(() => {
        parseMandate(clone(m));
        return true;
      }),
    );
  }
  return vectors;
}

// ---------------------------------------------------------------------------------------------
// Credentials

const ISS = "https://keelson.finance";
const L1_IAT = 1793750000;
const KB_IAT = demo.iat;
const NOW = demo.iat + 60;
const AUD = "agt-01";

interface Keys {
  issuer: Key;
  holder: Key;
  passkey: Key;
  agent: Key;
  other: Key;
}

function l1Payload(keys: Keys, extra: Record<string, unknown> = {}) {
  return {
    iss: ISS,
    iat: L1_IAT,
    vct: USER_CREDENTIAL_VCT,
    sub: "kls_usr_7f3a9c21",
    cnf: { jwk: keys.holder.jwk },
    cred: { id: "Zk3p0xQmH8vN1sLwT5uYdA", rp_id: "keelson.finance", jwk: keys.passkey.jwk },
    ...extra,
  };
}

/** The user credential as `issueUserCredential` issues it, with fixed `iat`, salts and nonces. */
function issueL1(keys: Keys, payload: Record<string, unknown>, sd: string[] = ["sub", "cred"]) {
  const salt = salts("l1");
  return new SDJwtVcInstance({
    signer: es256(keys.issuer),
    signAlg: "ES256",
    hasher: sdHasher,
    hashAlg: "sha-256",
    saltGenerator: () => b64u(salt()),
  }).issue(payload as never, { _sd: sd } as never);
}

/** A WebAuthn assertion over `challenge` with a deterministic DER signature. */
function assertion(passkey: Key, challenge: Uint8Array): UserAuth {
  const authenticatorData = Buffer.concat([
    sha256(utf8("keelson.finance")),
    Buffer.from([5, 0, 0, 0, 1]),
  ]);
  const clientDataJSON = utf8(
    JSON.stringify({
      type: "webauthn.get",
      challenge: b64u(challenge),
      origin: ISS,
      crossOrigin: false,
    }),
  );
  const signed = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
  return {
    authenticatorData: b64u(authenticatorData),
    clientDataJSON: b64u(clientDataJSON),
    signature: b64u(p256.sign(signed, passkey.secret, { format: "der" })),
  };
}

interface L2Params {
  keys: Keys;
  userCredential: string;
  payloadSd: object;
  disclosures: string[];
  userAuth: unknown;
  nonce: string;
  signer?: Key;
  header?: object;
  edit?: (kb: Record<string, unknown>) => void;
  delegatePayload?: (packed: object) => unknown;
  keepL1Disclosures?: boolean;
}

/** The open mandate as `issueOpenMandate` issues it, with fixed `iat` and salts. */
async function issueL2(p: L2Params): Promise<string> {
  const uc = p.keepL1Disclosures
    ? p.userCredential
    : `${p.userCredential.slice(0, p.userCredential.indexOf("~"))}~`;
  const salt = salts("l2");
  const delegate = await pack(
    { delegate_payload: [p.payloadSd] },
    { delegate_payload: { _sd: [0] } },
    { hasher: sdHasher, alg: "sha-256" },
    () => b64u(salt()),
  );
  const kb: Record<string, unknown> = {
    ...delegate.packedClaims,
    _sd_alg: "sha-256",
    iat: KB_IAT,
    aud: AUD,
    nonce: p.nonce,
    sd_hash: b64u(sdHasher(uc, "sha-256")),
    user_auth: p.userAuth,
  };
  if (p.delegatePayload) kb.delegate_payload = p.delegatePayload(delegate.packedClaims);
  p.edit?.(kb);
  const kbJwt = jws(
    p.header ?? { typ: OPEN_MANDATE_TYP, alg: "ES256" },
    kb,
    p.signer ?? p.keys.holder,
  );
  const referenced = JSON.stringify(kb.delegate_payload);
  const all = [
    ...delegate.disclosures
      .filter((d) => referenced.includes(d.digestSync({ hasher: sdHasher, alg: "sha-256" })))
      .map((d) => d.encode()),
    ...p.disclosures,
  ];
  return `${uc}~${kbJwt}~${all.map((d) => `${d}~`).join("")}`;
}

const pickL1 = (v: VerifiedCredential) => ({
  header: v.header,
  payload: v.payload,
  claims: v.claims,
});

async function credentialVectors() {
  const keys: Keys = {
    issuer: await key("issuer"),
    holder: await key("holder"),
    passkey: await key("passkey"),
    agent: await key("agent"),
    other: await key("other"),
  };
  const vectors: { name: string; input: unknown; expected: unknown }[] = [];

  const l1Case = async (name: string, token: string, k: Key = keys.issuer) =>
    vectors.push({
      name: `l1/${name}`,
      input: { token, typ: USER_CREDENTIAL_TYP, jwk: k.jwk },
      expected: await attempt(async () =>
        pickL1(await verifyCredential(token, USER_CREDENTIAL_TYP, k.publicKey)),
      ),
    });

  const l1 = await issueL1(keys, l1Payload(keys));
  const [l1Jwt, ...l1Disclosures] = l1.split("~").slice(0, -1) as [string, ...string[]];
  const l1Signed = decodePart(l1Jwt, 1);
  const l1Header = decodePart(l1Jwt, 0);
  const resignL1 = (
    header: object,
    edit: (p: Record<string, unknown>) => void,
    k = keys.issuer,
  ) => {
    const p = clone(l1Signed);
    edit(p);
    return jws(header, p, k);
  };
  const rest = l1.slice(l1Jwt.length);

  await l1Case("valid", l1);
  await l1Case("valid-bare", `${l1Jwt}~`);
  await l1Case("valid-only-sub", `${l1Jwt}~${l1Disclosures[0]}~`);
  await l1Case("valid-high-s", `${highS(l1Jwt)}${rest}`);
  await l1Case(
    "valid-kid-header",
    `${resignL1({ ...l1Header, kid: "issuer-1" }, () => {})}${rest}`,
  );
  await l1Case(
    "valid-explicit-sd-alg",
    `${resignL1(l1Header, (p) => (p._sd_alg = "sha-256"))}${rest}`,
  );
  await l1Case(
    "valid-cnf-with-d",
    `${resignL1(l1Header, (p) => ((p.cnf as { jwk: object }).jwk = { ...keys.holder.jwk, d: b64u(keys.holder.secret) }))}${rest}`,
  );
  await l1Case("error/wrong-key", l1, keys.other);
  await l1Case(
    "error/tampered-payload",
    `${l1Jwt.slice(0, l1Jwt.indexOf(".") + 5)}${l1Jwt[l1Jwt.indexOf(".") + 5] === "A" ? "B" : "A"}${l1Jwt.slice(l1Jwt.indexOf(".") + 6)}${rest}`,
  );
  const sig = l1Jwt.slice(l1Jwt.lastIndexOf(".") + 1);
  const last = sig.at(-1) as string;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const padded = alphabet[alphabet.indexOf(last) | 1] as string;
  await l1Case("error/non-canonical-signature", `${l1Jwt.slice(0, -1)}${padded}${rest}`);
  await l1Case("error/signature-padded", `${l1Jwt}=${rest}`);
  await l1Case("error/signature-empty", `${l1Jwt.slice(0, l1Jwt.lastIndexOf(".") + 1)}${rest}`);
  const unsigned = l1Jwt.slice(0, l1Jwt.lastIndexOf("."));
  const noneHeader = b64uJson({ ...l1Header, alg: "none" });
  await l1Case("error/alg-none", `${noneHeader}${unsigned.slice(unsigned.indexOf("."))}.${rest}`);
  await l1Case(
    "error/alg-none-with-signature",
    `${noneHeader}${unsigned.slice(unsigned.indexOf("."))}.${sig}${rest}`,
  );
  {
    const header = b64uJson({ ...l1Header, alg: "HS256" });
    const input = `${header}${unsigned.slice(unsigned.indexOf("."))}`;
    const hmacKey = await crypto.subtle.importKey(
      "raw",
      utf8(JSON.stringify(keys.issuer.jwk)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, utf8(input)));
    await l1Case("error/alg-hs256", `${input}.${b64u(mac)}${rest}`);
  }
  await l1Case("error/alg-es384", `${resignL1({ ...l1Header, alg: "ES384" }, () => {})}${rest}`);
  await l1Case(
    "error/header-jwk-injection",
    `${resignL1({ ...l1Header, jwk: keys.other.jwk }, () => {}, keys.other)}${rest}`,
  );
  await l1Case(
    "error/header-kid-injection",
    `${resignL1({ ...l1Header, kid: "issuer" }, () => {}, keys.other)}${rest}`,
  );
  await l1Case("error/crit", `${resignL1({ ...l1Header, crit: ["exp"] }, () => {})}${rest}`);
  await l1Case("error/typ", `${resignL1({ ...l1Header, typ: "vc+sd-jwt" }, () => {})}${rest}`);
  await l1Case("error/typ-missing", `${resignL1({ alg: "ES256" }, () => {})}${rest}`);
  await l1Case(
    "error/sd-alg-sha-512",
    `${resignL1(l1Header, (p) => (p._sd_alg = "sha-512"))}${rest}`,
  );
  await l1Case(
    "error/sd-alg-sha-512-bare",
    `${resignL1(l1Header, (p) => (p._sd_alg = "sha-512"))}~`,
  );
  await l1Case(
    "error/vct",
    `${resignL1(l1Header, (p) => (p.vct = "https://keelson.finance/credentials/user/v2"))}${rest}`,
  );
  await l1Case("error/cnf-missing", `${resignL1(l1Header, (p) => delete p.cnf)}${rest}`);
  await l1Case(
    "error/cnf-not-p256",
    `${resignL1(l1Header, (p) => ((p.cnf as { jwk: { crv: string } }).jwk.crv = "P-384"))}${rest}`,
  );
  await l1Case("error/iat-future", `${resignL1(l1Header, (p) => (p.iat = 4102444800))}${rest}`);
  await l1Case("error/exp-past", `${resignL1(l1Header, (p) => (p.exp = L1_IAT + 1))}${rest}`);
  await l1Case(
    "error/iat-not-number",
    `${resignL1(l1Header, (p) => (p.iat = "1793750000"))}${rest}`,
  );
  await l1Case("error/duplicate-disclosure", `${l1}${l1Disclosures[0]}~`);
  {
    const other = await issueL1(keys, l1Payload(keys, { sub: "kls_usr_other" }), ["sub"]);
    const foreign = other.split("~")[1] as string;
    await l1Case("error/unreferenced-disclosure", `${l1}${foreign}~`);
  }
  {
    const s = (i: number) => b64u(seed(`salt/l1/crafted/${i}`).subarray(0, 16));
    const crafted = async (
      name: string,
      d: unknown[],
      edit?: (p: Record<string, unknown>) => void,
    ) => {
      const { encoded, digest } = disclosure(d);
      const jwt = resignL1(l1Header, (p) => {
        (p._sd as string[]).push(digest);
        edit?.(p);
      });
      await l1Case(name, `${jwt}${rest}${encoded}~`);
    };
    await crafted("valid-extra-disclosed-claim", [s(0), "nickname", "andres"]);
    await crafted("error/reserved-name", [s(1), "_sd", []]);
    await crafted("error/colliding-claim", [s(2), "iss", "https://evil.example"]);
    await crafted("error/protected-claim-disclosed", [
      s(3),
      "status",
      { status_list: { idx: 0, uri: "https://keelson.finance/status" } },
    ]);
    await crafted(
      "error/protected-cnf-disclosed",
      [s(4), "cnf", { jwk: keys.other.jwk }],
      (p) => delete p.cnf,
    );
    await crafted("error/sd-decoy-claim", [s(5), "x", { _sd_decoy: 1 }]);
    await crafted("error/ellipsis-in-object", [s(6), "x", { "...": "y" }]);
    await crafted(
      "error/status-list",
      [s(7), "nickname", "a"],
      (p) => (p.status = { status_list: { idx: 0, uri: "https://keelson.finance/status" } }),
    );
  }
  await l1Case("error/status-string", `${resignL1(l1Header, (p) => (p.status = "x"))}${rest}`);
  await l1Case("error/status-null", `${resignL1(l1Header, (p) => (p.status = null))}${rest}`);
  const rawL1 = (edit: (json: string) => string) =>
    `${jwsRaw(l1Header, edit(JSON.stringify(l1Signed)), keys.issuer)}${rest}`;
  await l1Case(
    "error/claim-fraction",
    rawL1((j) => j.replace(/}$/, ',"score":1.5}')),
  );
  await l1Case(
    "error/claim-integral-float",
    rawL1((j) => j.replace(/}$/, ',"score":1.0}')),
  );
  await l1Case(
    "error/iat-float",
    rawL1((j) => j.replace(`"iat":${L1_IAT}`, `"iat":${L1_IAT}.0`)),
  );
  await l1Case(
    "error/claim-lone-surrogate",
    rawL1((j) => j.replace(/}$/, ',"nick":"\\ud800"}')),
  );
  await l1Case(
    "error/claim-depth-33",
    rawL1((j) => j.replace(/}$/, `,"deep":${nest(32)}}`)),
  );
  await l1Case(
    "valid-claim-depth-32",
    rawL1((j) => j.replace(/}$/, `,"deep":${nest(31)}}`)),
  );
  const holderX = keys.holder.jwk.x;
  const badXs: [string, string][] = [
    ["padded", `${holderX}=`],
    ["leading-space", ` ${holderX}`],
    ["trailing-dot", `${holderX}.`],
    ["short", holderX.slice(1)],
    ["plus", `+${holderX.slice(1)}`],
    [
      "pad-bits",
      `${holderX.slice(0, -1)}${alphabet[alphabet.indexOf(holderX.at(-1) as string) ^ 1]}`,
    ],
  ];
  for (const [name, x] of badXs) {
    await l1Case(
      `error/holder-x-${name}`,
      `${resignL1(l1Header, (p) => ((p.cnf as { jwk: { x: string } }).jwk.x = x))}${rest}`,
    );
  }
  await l1Case("error/no-separator", l1Jwt);
  await l1Case("error/empty-disclosure", `${l1Jwt}~~${l1Disclosures[0]}~`);
  await l1Case("error/key-binding-present", `${l1}${l1Jwt}`);
  await l1Case("error/two-segments", `${unsigned}${rest}`);
  vectors.push({
    name: "l1/error/expected-open-mandate",
    input: {
      token: l1,
      typ: OPEN_MANDATE_TYP,
      jwk: keys.issuer.jwk,
      opts: { expectedAud: AUD, expectedNonce: "n", now: NOW, maxSkewSec: 0 },
    },
    expected: await attempt(() =>
      verifyCredential(l1, OPEN_MANDATE_TYP, keys.issuer.publicKey, {
        expectedAud: AUD,
        expectedNonce: "n",
        now: NOW,
        maxSkewSec: 0,
      }),
    ),
  });

  // Open mandates.
  const live = mandate();
  live.user.cred.jwk = keys.passkey.jwk;
  live.agent.cnf.jwk = { ...keys.agent.jwk, kid: "agt-01" };
  const cmSalt = seed("salt/l2/commitment").subarray(0, 16);
  const cm = await mandateCommitment(live, cmSalt);
  live.zk.commitment = field(cm);
  const { payloadSd, disclosures } = await buildSdPayload(live, salts("l2/sd"));
  const userAuth = assertion(keys.passkey, mandateChallenge(hSd(payloadSd), cm));
  const base: L2Params = {
    keys,
    userCredential: l1,
    payloadSd,
    disclosures,
    userAuth,
    nonce: live.nonce,
  };
  const opts: OpenMandateVerifyOptions = {
    expectedAud: AUD,
    expectedNonce: live.nonce,
    now: NOW,
    maxSkewSec: 60,
  };

  const l2Case = async (
    name: string,
    token: string,
    o: OpenMandateVerifyOptions = opts,
    k: Key = keys.issuer,
  ) =>
    vectors.push({
      name: `l2/${name}`,
      input: { token, typ: OPEN_MANDATE_TYP, jwk: k.jwk, opts: o },
      expected: await attempt(async () => {
        const v = (await verifyCredential(
          token,
          OPEN_MANDATE_TYP,
          k.publicKey,
          o,
        )) as VerifiedOpenMandate;
        return {
          header: v.header,
          payload: v.payload,
          claims: v.claims,
          userAuth: v.userAuth,
          userCredential: pickL1(v.userCredential),
        };
      }),
    });

  const l2 = await issueL2(base);
  await l2Case("valid", l2);
  await l2Case("valid-l1-with-disclosures", await issueL2({ ...base, keepL1Disclosures: true }));
  await l2Case(
    "valid-high-s",
    (() => {
      const parts = l2.split("~");
      return parts.with(2, highS(parts[2] as string)).join("~");
    })(),
  );
  await l2Case(
    "error/delegate-in-clear",
    await issueL2({ ...base, delegatePayload: () => [payloadSd] }),
  );
  await l2Case(
    "valid-extra-user-auth-member",
    await issueL2({ ...base, userAuth: { ...userAuth, extra: 1 } }),
  );
  await l2Case("error/wrong-issuer-key", l2, opts, keys.other);
  await l2Case("error/wrong-holder-key", await issueL2({ ...base, signer: keys.other }));
  await l2Case("error/aud", l2, { ...opts, expectedAud: "agt-02" });
  await l2Case("error/nonce", l2, { ...opts, expectedNonce: "AAAAAAAAAAAAAAAAAAAAAA" });
  await l2Case(
    "error/withheld-disclosure",
    (() => {
      const login = disclosures.find((d) => decodeDisclosure(d)[1] === "app_login_id");
      return l2.replace(`~${login}~`, "~");
    })(),
  );
  await l2Case(
    "kb-iat-within-skew",
    await issueL2({ ...base, edit: (kb) => (kb.iat = NOW + 30) }),
    { ...opts, maxSkewSec: 30 },
  );
  await l2Case(
    "error/kb-iat-beyond-skew",
    await issueL2({ ...base, edit: (kb) => (kb.iat = NOW + 31) }),
    { ...opts, maxSkewSec: 30 },
  );
  await l2Case("error/kb-iat-missing", await issueL2({ ...base, edit: (kb) => delete kb.iat }));
  await l2Case("not-expired-within-skew", l2, { ...opts, now: live.exp + 29, maxSkewSec: 30 });
  await l2Case("error/expired", l2, { ...opts, now: live.exp + 30, maxSkewSec: 30 });
  await l2Case("error/not-yet-valid", l2, { ...opts, now: live.nbf - 31, maxSkewSec: 30 });
  await l2Case("error/now-unsafe", l2, { ...opts, now: 2 ** 53 });
  await l2Case("error/skew-negative", l2, { ...opts, maxSkewSec: -1 });
  await l2Case(
    "error/sd-hash",
    await issueL2({ ...base, edit: (kb) => (kb.sd_hash = b64u(seed("sd_hash"))) }),
  );
  await l2Case(
    "error/kb-sd-alg-sha-512",
    await issueL2({ ...base, edit: (kb) => (kb._sd_alg = "sha-512") }),
  );
  await l2Case("error/kb-typ", await issueL2({ ...base, header: { typ: "kb+jwt", alg: "ES256" } }));
  await l2Case(
    "error/kb-alg-none",
    (() => {
      const parts = l2.split("~");
      const kb = parts[2] as string;
      const header = b64uJson({ typ: OPEN_MANDATE_TYP, alg: "none" });
      return parts
        .with(2, `${header}${kb.slice(kb.indexOf("."), kb.lastIndexOf(".") + 1)}`)
        .join("~");
    })(),
  );
  await l2Case(
    "error/kb-header-jwk-injection",
    await issueL2({
      ...base,
      signer: keys.other,
      header: { typ: OPEN_MANDATE_TYP, alg: "ES256", jwk: keys.other.jwk },
    }),
  );
  await l2Case(
    "error/cnf-differs",
    await issueL2({ ...base, payloadSd: { ...payloadSd, cnf: { jwk: keys.other.jwk } } }),
  );
  await l2Case(
    "error/two-delegates",
    await issueL2({
      ...base,
      delegatePayload: (packed) => [
        ...(packed as { delegate_payload: unknown[] }).delegate_payload,
        payloadSd,
      ],
    }),
  );
  await l2Case("error/no-delegate", await issueL2({ ...base, delegatePayload: () => [] }));
  await l2Case(
    "error/user-auth-not-b64url",
    await issueL2({ ...base, userAuth: { ...userAuth, signature: "not b64url" } }),
  );
  await l2Case("error/user-auth-missing", await issueL2({ ...base, userAuth: undefined }));
  {
    const leaky = await issueL1(
      keys,
      l1Payload(keys, { cnf: { jwk: { ...keys.holder.jwk, d: b64u(keys.holder.secret) } } }),
    );
    await l2Case("error/holder-cnf-with-d", await issueL2({ ...base, userCredential: leaky }));
  }
  {
    const padded = await issueL1(
      keys,
      l1Payload(keys, { cnf: { jwk: { ...keys.holder.jwk, y: `${keys.holder.jwk.y}=` } } }),
    );
    await l2Case("error/holder-y-padded", await issueL2({ ...base, userCredential: padded }));
  }
  await l2Case(
    "error/delegate-payload-object",
    await issueL2({ ...base, delegatePayload: () => ({ 0: payloadSd, length: 1 }) }),
  );
  {
    const { packedClaims, disclosures: ds } = await pack(
      { cnf: { jwk: keys.agent.jwk }, cap: 100 },
      { _sd: ["cap"] },
      { hasher: sdHasher, alg: "sha-256" },
      () => b64u(salts("l2/not-a-mandate")()),
    );
    await l2Case(
      "error/not-a-mandate",
      await issueL2({ ...base, payloadSd: packedClaims, disclosures: ds.map((d) => d.encode()) }),
    );
  }
  {
    const isItem = (v: unknown) => (v as { id?: unknown } | null)?.id === "sku-trail-10";
    await l2Case(
      "error/withheld-acceptable-item",
      l2
        .split("~")
        .filter((d, i) => i < 3 || d === "" || !isItem(decodeDisclosure(d).at(-1)))
        .join("~"),
    );
    const two = clone(live);
    two.payment.constraints.forEach((c) => {
      if (c.type === "payment.allowed_payees") c.allowed.push({ paypal_merchant_id: "MERCH2" });
    });
    two.checkout.constraints.forEach((c) => {
      if (c.type === "checkout.allowed_merchants") {
        c.allowed.push({
          id: "mrc_two",
          name: "Two",
          website: "https://two.example",
          paypal_merchant_id: "MERCH2",
        });
      }
    });
    const twoSd = await buildSdPayload(two, salts("l2/two"));
    const twoToken = await issueL2({
      ...base,
      payloadSd: twoSd.payloadSd,
      disclosures: twoSd.disclosures,
    });
    await l2Case("valid-two-merchants", twoToken);
    const strip = (test: (v: Record<string, unknown>) => boolean) =>
      twoToken
        .split("~")
        .filter((d, i) => {
          if (i < 3 || d === "") return true;
          const v = decodeDisclosure(d).at(-1);
          return !(v !== null && typeof v === "object" && test(v as Record<string, unknown>));
        })
        .join("~");
    await l2Case(
      "error/withheld-merchant",
      strip((v) => v.id === "mrc_two"),
    );
    await l2Case(
      "error/withheld-payee",
      strip((v) => v.paypal_merchant_id === "MERCH2" && !("id" in v)),
    );
  }
  vectors.push({
    name: "l2/error/unknown-typ",
    input: { token: l2, typ: "vc+sd-jwt", jwk: keys.issuer.jwk, opts },
    expected: await attempt(() =>
      verifyCredential(l2, "vc+sd-jwt" as typeof OPEN_MANDATE_TYP, keys.issuer.publicKey, opts),
    ),
  });
  await l2Case("error/missing-key-binding", `${l1Jwt}~~`);
  await l2Case("error/l1-only", l1);
  await l2Case("error/trailing-separator-missing", l2.slice(0, -1));
  vectors.push({
    name: "l2/error/expected-user-credential",
    input: { token: l2, typ: USER_CREDENTIAL_TYP, jwk: keys.issuer.jwk },
    expected: await attempt(() => verifyCredential(l2, USER_CREDENTIAL_TYP, keys.issuer.publicKey)),
  });
  return vectors;
}

writeJson("sd", await sdVectors());
writeJson("challenge", await challengeVectors());
writeJson("commitment", await commitmentVectors());
writeJson("credentials", await credentialVectors());
writeJson(
  "colors",
  fieldColors(mandate(), { merchantSignedCheckout: false, zkTlsFields: new Set() }),
);
