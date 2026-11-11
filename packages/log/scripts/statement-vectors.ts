/**
 * Writes the v2 leaf golden vectors to internal/alibilog/testdata/statement-v2: real encoding and
 * signing code over the countersigned facts of two production sandbox Alibis, with fixed test keys
 * (tdx = 0x01…01, nitro = 0x02…02). Run: node packages/log/scripts/statement-vectors.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  type CardAuthorization,
  type CardSettlement,
  type Countersign,
  cardAuthorizationDigest,
  cardSettlementDigest,
  countersignDigest,
  keelsonDomain,
} from "@keelson/core/eip712";
import { addressOf, encode, leafHash } from "@keelson/scitt";
import { signEs256k } from "@keelson/scitt/testing";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Tag } from "cbor2";
import { getAddress, type Hex } from "viem";
import { cardRefCommit, paypalRefCommit } from "../src/leaf.ts";
import {
  BRIDGE_CONTENT_TYPE,
  bridgeClaimsBytes,
  CARD_AUTHORIZATION_CONTENT_TYPE,
  CARD_SETTLEMENT_CONTENT_TYPE,
  cardAuthorizationClaimsBytes,
  cardSettlementClaimsBytes,
  claimsBytes,
  type LegSignature,
  type StatementClaims,
  statementProtected,
  ulidOfRequestId,
} from "../src/statement.ts";

const root = new URL("../../../", import.meta.url);
const out = new URL("internal/alibilog/testdata/statement-v2/", root);
const keys = [hexToBytes("01".repeat(32)), hexToBytes("02".repeat(32))] as const;
const address = (k: Uint8Array) =>
  getAddress(`0x${bytesToHex(addressOf(secp256k1.getPublicKey(k, false)))}`);

const fixture = (id: string) =>
  JSON.parse(readFileSync(new URL(`packages/alibi/test/fixtures/${id}.alibi`, root), "utf8"));
const UINTS = [
  "agentId",
  "amount",
  "currency",
  "category",
  "decision",
  "failedFieldsMask",
  "issuedAt",
  "expiresAt",
];

function sign712(digest: Hex, k: Uint8Array): Hex {
  const sig = secp256k1.sign(hexToBytes(digest.slice(2)), k, {
    prehash: false,
    format: "recovered",
  });
  const rsv = new Uint8Array(65);
  rsv.set(sig.subarray(1), 0);
  rsv[64] = (sig[0] as number) + 27;
  return `0x${bytesToHex(rsv)}`;
}

function vector(
  name: string,
  id: string,
  mode: "2of2" | "degraded",
  edit: Partial<Record<string, string>>,
  payRef: boolean,
) {
  const f = fixture(id);
  const raw = { ...f.tee.countersign, ...edit } as Record<string, string>;
  const countersign = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, UINTS.includes(k) ? BigInt(v) : v]),
  ) as unknown as Countersign;
  const chainId = f.tee.domain.chain_id as 421614;
  const verifyingContract = f.tee.domain.verifying_contract as Hex;
  const digest = countersignDigest(countersign, keelsonDomain(chainId, verifyingContract));
  const measurement = (kind: string) =>
    `0x${(f.tee.attestations.find((a: { kind: string }) => a.kind === kind)?.measurement ?? `${kind}:${"00".repeat(32)}`).split(":")[1]}` as Hex;
  const leg = (i: 0 | 1): LegSignature => ({
    kind: i === 0 ? "tdx" : "nitro",
    signer: address(keys[i]),
    signature: sign712(digest, keys[i]),
    measurement: i === 0 ? measurement("tdx") : (measurement("nitro") ?? `0x${"00".repeat(32)}`),
  });
  const claims: StatementClaims = {
    countersign,
    chainId,
    verifyingContract,
    mode,
    legs: mode === "2of2" ? [leg(0), leg(1)] : [leg(0)],
    ...(payRef
      ? {
          payRef: paypalRefCommit(
            hexToBytes(f.paypal.ref_salt.slice(2)),
            f.paypal.order_id,
            f.paypal.authorization_id,
          ),
        }
      : {}),
  };
  const alibiId = ulidOfRequestId(countersign.requestId);
  const signerIndex = mode === "2of2" ? 1 : 0;
  const prot = statementProtected(
    claims.legs[signerIndex]?.signer as Hex,
    alibiId,
    Number(countersign.issuedAt),
  );
  const payload = claimsBytes(claims);
  const s = signEs256k(prot, payload, keys[signerIndex]);
  const statement = encode(new Tag(18, [s.protected, s.unprotected, s.payload, s.signature]));
  const tbs = encode(["Signature1", prot, new Uint8Array(0), payload]);
  const inputs = {
    alibi_id: alibiId,
    countersign: raw,
    chain_id: chainId,
    verifying_contract: verifyingContract,
    mode,
    legs: claims.legs,
    ...(claims.payRef ? { pay_ref: claims.payRef } : {}),
  };
  writeFileSync(
    new URL(`${name}.json`, out),
    `${JSON.stringify(
      {
        name,
        inputs,
        countersign_digest_hex: digest.slice(2),
        claims_hex: bytesToHex(payload),
        protected_hex: bytesToHex(prot),
        tbs_hex: bytesToHex(tbs),
        statement_hex: bytesToHex(statement),
        leaf_hash_hex: bytesToHex(leafHash(statement)),
      },
      null,
      2,
    )}\n`,
  );
}

/** Card statements under the `card-2of2` purchase: its leaf hash is their parent. */
function cardVectors() {
  const purchase = JSON.parse(readFileSync(new URL("card-2of2.json", out), "utf8"));
  const f = fixture("01M6ZWZJHWRRHQEYNJAT7NMSV8");
  const chainId = f.tee.domain.chain_id as 421614;
  const verifyingContract = f.tee.domain.verifying_contract as Hex;
  const domain = keelsonDomain(chainId, verifyingContract);
  const cs = purchase.inputs.countersign as Record<string, string>;
  const parent = `0x${purchase.leaf_hash_hex}` as Hex;
  const cardRef = cardRefCommit(
    hexToBytes(f.paypal.ref_salt.slice(2)),
    "lithic",
    "card_vector_token",
  );
  const alibiId = purchase.inputs.alibi_id as string;
  const legsOver = (digest: Hex) =>
    ([0, 1] as const).map((i) => ({
      ...(purchase.inputs.legs[i] as LegSignature),
      signature: sign712(digest, keys[i]),
    })) as [LegSignature, LegSignature];
  const write = (
    name: string,
    kind: string,
    facts: Record<string, string>,
    payload: Uint8Array,
    iat: number,
    contentType: string,
    legs: LegSignature[],
    digest: Hex,
  ) => {
    const prot = statementProtected(legs[1]?.signer as Hex, alibiId, iat, contentType);
    const s = signEs256k(prot, payload, keys[1]);
    const statement = encode(new Tag(18, [s.protected, s.unprotected, s.payload, s.signature]));
    writeFileSync(
      new URL(`${name}.json`, out),
      `${JSON.stringify(
        {
          name,
          kind,
          inputs: {
            alibi_id: alibiId,
            facts,
            parent,
            ...(kind === "card-authorization" ? { card_ref: cardRef } : {}),
            chain_id: chainId,
            verifying_contract: verifyingContract,
            mode: "2of2",
            legs,
          },
          digest_hex: digest.slice(2),
          claims_hex: bytesToHex(payload),
          protected_hex: bytesToHex(prot),
          statement_hex: bytesToHex(statement),
          leaf_hash_hex: bytesToHex(leafHash(statement)),
        },
        null,
        2,
      )}\n`,
    );
  };
  for (const [name, decision, failedMask] of [
    ["card-auth-approve", "1", "0"],
    ["card-auth-decline", "2", "16"],
  ] as const) {
    const facts = {
      requestId: cs.requestId as string,
      countersignDigest: `0x${purchase.countersign_digest_hex}`,
      authorizationHash: `0x${bytesToHex(sha256(new TextEncoder().encode(`authorization ${name}`)))}`,
      merchantHash: `0x${bytesToHex(sha256(new TextEncoder().encode("merchant vector")))}`,
      mcc: "5661",
      country: "0x5553",
      amount: "100",
      currency: "840",
      decision,
      failedMask,
      issuedAt: String(Number(cs.issuedAt) + 60),
    };
    const a = Object.fromEntries(
      Object.entries(facts).map(([k, x]) => [
        k,
        ["mcc", "amount", "currency", "decision", "failedMask", "issuedAt"].includes(k)
          ? BigInt(x)
          : x,
      ]),
    ) as unknown as CardAuthorization;
    const digest = cardAuthorizationDigest(a, domain);
    const legs = legsOver(digest);
    write(
      name,
      "card-authorization",
      facts,
      cardAuthorizationClaimsBytes({
        authorization: a,
        cardRef,
        parent,
        chainId,
        verifyingContract,
        mode: "2of2",
        legs,
      }),
      Number(facts.issuedAt),
      CARD_AUTHORIZATION_CONTENT_TYPE,
      legs,
      digest,
    );
  }
  const facts = {
    requestId: cs.requestId as string,
    cardRef,
    transactionHash: `0x${bytesToHex(sha256(new TextEncoder().encode("issuer transaction response")))}`,
    settledMinor: "100",
    currency: "840",
    status: "1",
    settledAt: String(Number(cs.issuedAt) + 3600),
    observedAt: String(Number(cs.issuedAt) + 3700),
  };
  const t = Object.fromEntries(
    Object.entries(facts).map(([k, x]) => [
      k,
      ["settledMinor", "currency", "status", "settledAt", "observedAt"].includes(k) ? BigInt(x) : x,
    ]),
  ) as unknown as CardSettlement;
  const digest = cardSettlementDigest(t, domain);
  const legs = legsOver(digest);
  write(
    "card-settlement",
    "card-settlement",
    facts,
    cardSettlementClaimsBytes({
      settlement: t,
      parent,
      chainId,
      verifyingContract,
      mode: "2of2",
      legs,
    }),
    Number(facts.observedAt),
    CARD_SETTLEMENT_CONTENT_TYPE,
    legs,
    digest,
  );
}

/** Bridges of the two real v1 fixtures: their own legs, a third test key as leg A's current signer. */
function bridgeVector(name: string, id: string) {
  const f = fixture(id);
  const bridgeKey = hexToBytes("03".repeat(32));
  const raw = f.tee.countersign as Record<string, string>;
  const countersign = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, UINTS.includes(k) ? BigInt(v) : v]),
  ) as unknown as Countersign;
  const legs = (f.tee.signatures as { kind: "tdx" | "nitro"; signer: Hex; signature: Hex }[]).map(
    (s, i) => ({
      kind: s.kind,
      signer: getAddress(s.signer),
      signature: s.signature,
      measurement: `0x${f.tee.attestations[i].measurement.split(":")[1]}` as Hex,
    }),
  ) as StatementClaims["legs"];
  const predecessor =
    `0x${bytesToHex(leafHash(Uint8Array.from(Buffer.from(f.leaf, "base64"))))}` as Hex;
  const claims = {
    countersign,
    chainId: f.tee.domain.chain_id as number,
    verifyingContract: f.tee.domain.verifying_contract as Hex,
    mode: f.tee.mode as "2of2" | "degraded",
    legs,
    predecessor,
  };
  const signer = address(bridgeKey);
  const alibiId = ulidOfRequestId(countersign.requestId);
  const prot = statementProtected(
    signer,
    alibiId,
    Number(countersign.issuedAt),
    BRIDGE_CONTENT_TYPE,
  );
  const payload = bridgeClaimsBytes(claims);
  const s = signEs256k(prot, payload, bridgeKey);
  const statement = encode(new Tag(18, [s.protected, s.unprotected, s.payload, s.signature]));
  writeFileSync(
    new URL(`${name}.json`, out),
    `${JSON.stringify(
      {
        name,
        inputs: {
          alibi_id: alibiId,
          countersign: raw,
          chain_id: claims.chainId,
          verifying_contract: claims.verifyingContract,
          mode: claims.mode,
          legs,
          predecessor,
          bridge_signer: signer,
        },
        claims_hex: bytesToHex(payload),
        protected_hex: bytesToHex(prot),
        statement_hex: bytesToHex(statement),
        leaf_hash_hex: bytesToHex(leafHash(statement)),
      },
      null,
      2,
    )}\n`,
  );
}

mkdirSync(out, { recursive: true });
vector("allow-2of2", "01M6ZWZJHWRRHQEYNJAT7NMSV8", "2of2", {}, true);
vector(
  "deny-2of2",
  "01M6ZWZJHWRRHQEYNJAT7NMSV8",
  "2of2",
  { decision: "2", failedFieldsMask: "1" },
  true,
);
vector("allow-degraded", "01M6ZX07MFWDDDW4199FDJHWEG", "degraded", {}, true);
vector("card-2of2", "01M6ZWZJHWRRHQEYNJAT7NMSV8", "2of2", {}, false);
cardVectors();
bridgeVector("bridge-2of2", "01M6ZWZJHWRRHQEYNJAT7NMSV8");
bridgeVector("bridge-degraded", "01M6ZX07MFWDDDW4199FDJHWEG");
