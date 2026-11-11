import type { Json } from "@keelson/core";
import { countersignDigest, type KeelsonChainId, keelsonDomain } from "@keelson/core/eip712";
import {
  LEAF_PREFIX,
  type LegSignature,
  leafHash,
  type ParsedStatement,
  parseStatementLeaf,
} from "@keelson/log";
import { decodeSign1, readCollection, type Sign1, TST_CTT } from "@keelson/scitt";
import { fromBase64, toBase64, toBase64url } from "../b64.ts";
import { registeredOf, statementOf, versionOf } from "../codec.ts";
import {
  ALIBI_MEDIA_TYPE,
  type AlibiBundle,
  type AlibiBundleV2,
  type AlibiReceipt,
  type AlibiReceiptV2,
  type AnyAlibi,
} from "../schema.ts";

/** What the v2-only checks read: the statement as registered and as presented. */
export interface StatementView {
  input: AlibiBundleV2 | AlibiReceiptV2;
  /** The registered statement: the log leaf. */
  registered: Uint8Array;
  transparent: Sign1;
  /** The claims, read without verifying any signature; `scitt.statement` verifies them. */
  parsed: ParsedStatement | null;
  parseError?: string;
  /** A bridge bundle's v1 leaf. */
  predecessor?: Uint8Array;
}

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
const hexToB64url = (hex: string) =>
  toBase64url(
    Uint8Array.from((hex.slice(2).match(/../g) ?? []).map((b) => Number.parseInt(b, 16))),
  );
const rfc3339 = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The statement view of a v2 input; `null` for v1. */
export function statementView(input: AnyAlibi): StatementView | null {
  if (versionOf(input) !== 2) return null;
  const v2 = input as AlibiBundleV2 | AlibiReceiptV2;
  const registered = registeredOf(v2);
  const transparent = decodeSign1(statementOf(v2));
  const base = {
    input: v2,
    registered,
    transparent,
    ...("predecessor" in v2 && v2.predecessor ? { predecessor: fromBase64(v2.predecessor) } : {}),
  };
  try {
    return { ...base, parsed: parseStatementLeaf(registered, { verify: false }) };
  } catch (err) {
    return { ...base, parsed: null, parseError: (err as Error).message };
  }
}

/** The body of a bridge's v1 leaf: the v1 `leaf_view` its preimage checks read. */
function predecessorView(view: StatementView): Record<string, Json> {
  const text = new TextDecoder().decode(view.predecessor ?? new Uint8Array());
  if (!text.startsWith(LEAF_PREFIX)) return {};
  try {
    return JSON.parse(text.slice(LEAF_PREFIX.length)) as Record<string, Json>;
  } catch {
    return {};
  }
}

/** The legs' attestation entries from the CMW collection, in v1's shape. */
function attestationsOf(b: AlibiBundleV2): AlibiBundle["tee"]["attestations"] {
  const out: AlibiBundle["tee"]["attestations"] = [];
  for (const [label, record] of readCollection(b.attestation)) {
    const entry = JSON.parse(
      new TextDecoder().decode(record.value),
    ) as AlibiBundle["tee"]["attestations"][number];
    if (entry.kind !== label) throw new TypeError(`the ${label} record is the ${entry.kind} leg's`);
    out.push(entry);
  }
  return out;
}

/**
 * A v2 input in the v1 shape the checks read: the leaf is the registered statement, `tee` comes
 * from the statement's claims and the CMW collection, `timestamps` from label 270 and the bundle.
 */
export function legacyOf(input: AnyAlibi, view: StatementView | null): AlibiBundle | AlibiReceipt {
  if (!view) return input as AlibiBundle | AlibiReceipt;
  const p = view.parsed;
  const tst = view.transparent.unprotected.get(TST_CTT);
  const timestamps = [
    ...(tst instanceof Uint8Array ? [{ tsa: "", token: toBase64(tst) }] : []),
    ...(("timestamps" in view.input && view.input.timestamps) || []),
  ];
  const leaf = toBase64(view.registered);
  if (!("attestation" in view.input)) {
    return {
      alibi_id: view.input.alibi_id,
      leaf,
      leaf_hash: toBase64url(leafHash(view.registered)),
      tlog_proof: view.input.tlog_proof ?? "",
      ...(view.input.anchor ? { anchor: view.input.anchor } : {}),
      timestamps,
    };
  }
  const b = view.input;
  if (p?.kind !== "purchase" && p?.kind !== "bridge") {
    throw new TypeError(view.parseError ?? "not a purchase statement");
  }
  const c = p.claims;
  const countersign = Object.fromEntries(
    Object.entries(c.countersign).map(([k, v]) => [k, UINTS.includes(k) ? String(v) : v]),
  ) as AlibiBundle["tee"]["countersign"];
  const digest = countersignDigest(
    c.countersign,
    keelsonDomain(c.chainId as KeelsonChainId, c.verifyingContract),
  );
  const legs = c.legs as LegSignature[];
  const {
    statement: _,
    attestation: __,
    type: ___,
    timestamps: ____,
    predecessor: _____,
    ...rest
  } = b;
  return {
    ...rest,
    type: ALIBI_MEDIA_TYPE,
    leaf,
    leaf_view:
      p.kind === "bridge"
        ? predecessorView(view)
        : ({
            agent_id: countersign.agentId,
            alibi_id: b.alibi_id,
            cart_hash: hexToB64url(c.countersign.cartHash),
            countersign_digest: hexToB64url(digest),
            eval_hash: hexToB64url(c.countersign.evalHash),
            evidence_root: hexToB64url(c.countersign.evidenceRoot),
            issued_at: rfc3339(Number(c.countersign.issuedAt)),
            mandate_commitment: hexToB64url(c.countersign.mandateCommitment),
            mandate_hash: hexToB64url(c.countersign.mandateHash),
            measurements: legs.map((l) => hexToB64url(l.measurement)),
            mode: c.mode,
            ...("payRef" in c && c.payRef ? { paypal_ref_commit: hexToB64url(c.payRef) } : {}),
            policy_set_hash: hexToB64url(c.countersign.policySetHash),
            tee_sigs: legs.map((l) => hexToB64url(l.signature)),
          } as Record<string, Json>),
    timestamps,
    tee: {
      domain: {
        name: "Keelson",
        version: "1",
        chain_id: c.chainId,
        verifying_contract: c.verifyingContract,
      },
      countersign,
      digest,
      mode: c.mode,
      signatures: legs.map((l) => ({ kind: l.kind, signer: l.signer, signature: l.signature })),
      attestations: attestationsOf(b),
    },
  } as AlibiBundle;
}

/** Where a v1-shaped pointer lives in a v2 Alibi. */
export function v2Pointer(p: string): string {
  if (/^\/tee\/attestations\/0(\/|$)/.test(p)) return "/attestation/tdx";
  if (/^\/tee\/attestations\/1(\/|$)/.test(p)) return "/attestation/nitro";
  if (p === "/tee/attestations") return "/attestation";
  if (/^\/(tee|leaf|leaf_view|timestamps|leaf_hash)(\/|$)/.test(p)) return "/statement";
  return p;
}
