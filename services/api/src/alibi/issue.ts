// Loads reflect-metadata before @keelson/alibi/verify pulls in @keelson/attest (see tee/attest.ts).
import "../tee/attest.ts";
import {
  ALIBI_MEDIA_TYPE,
  type AlibiBundle,
  alibiSchema,
  encodeAlibi,
  MAX_ALIBI_BYTES,
  toBase64,
} from "@keelson/alibi";
import { verifyAlibi } from "@keelson/alibi/verify";
import { type Json, jcs, toHex } from "@keelson/core";
import {
  alibis,
  and,
  asc,
  chainTxs,
  channel3Observations,
  type Db,
  eq,
  evidenceAccess,
  evidenceBundles,
  evidenceItems,
  inArray,
  mandates,
  purchaseHolds,
  purchases,
  teeSigners,
  timestamps,
} from "@keelson/db";
import { inclusionPath, type Manifest } from "@keelson/evidence";
import {
  type AppendResult,
  LEAF_PREFIX,
  LOG_ORIGINS,
  LOG_VKEYS,
  LOG_WITNESSES,
  leafHash,
  parseWitnessPolicy,
} from "@keelson/log";
import { isPersonalDisclosure, withholdPersonal } from "@keelson/mandate";
import { holdCustomId, purchaseHoldCustomId, purchaseHoldDigest } from "@keelson/paypal";
import { calculateJwkThumbprint, type JWK } from "jose";
import type { Logger } from "pino";
import { getAddress } from "viem";
import { countersignOf, purchaseLeaf } from "../pipeline/leaf.ts";
import { VERIFYING_CONTRACT } from "../tee/config.ts";
import type { TeeConfig } from "../tee/signers.ts";
import { span } from "../tracing.ts";
import { rootKey } from "../zk/c3.ts";

/** The item types an Alibi discloses: the PII-redacted public ones. */
const DISCLOSED = [
  "api.product",
  "api.cart",
  "channel3.observation",
  "tlsn.web_fact",
  "api.checkout",
] as const;
const ENV: Readonly<Record<number, "s" | "p">> = { 421614: "s", 42161: "p" };
const KIND = { 1: "tdx", 2: "nitro" } as const;

/**
 * `leaf`: the log answered for another leaf; `data`: what Postgres holds cannot make an Alibi;
 * `format`, `size`, `verify`: the bundle built is malformed, too large or does not verify;
 * `issuer`: the signer attests another credential issuer; `config`: the API cannot issue at all.
 */
export type AlibiIssueCode = "leaf" | "data" | "format" | "size" | "verify" | "issuer" | "config";

/** The purchase cannot get an Alibi; retrying does not change that. */
export class AlibiIssueError extends Error {
  readonly code: AlibiIssueCode;

  constructor(code: AlibiIssueCode, message: string) {
    super(message);
    this.name = "AlibiIssueError";
    this.code = code;
  }
}

export interface IssueDeps {
  db: Db;
  log: Logger;
  tee?: Pick<TeeConfig, "client"> | undefined;
  /** The payee's PayPal merchant id, which the invoice id's digest binds. */
  merchantId?: string | undefined;
}

export interface IssueInput {
  purchaseId: string;
  append: AppendResult;
}

const policies = new Map<string, string>();

/** The origin's published witness policy, once it is the policy pinned in code. */
async function policyOf(origin: string): Promise<string> {
  const cached = policies.get(origin);
  if (cached) return cached;
  const res = await fetch(`https://${origin}/policy`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`policy of ${origin}: ${res.status}`);
  const text = await res.text();
  const p = parseWitnessPolicy(text);
  const witnesses = LOG_WITNESSES[origin];
  if (
    jcs(p.logs) !== jcs((LOG_VKEYS[origin] ?? []) as string[]) ||
    !witnesses ||
    p.quorum.k !== witnesses.quorum ||
    jcs(p.quorum.members.map((m) => p.witnesses.get(m) ?? "")) !== jcs([...witnesses.vkeys])
  ) {
    throw new Error(`the published policy of ${origin} is not the pinned one`);
  }
  policies.set(origin, text);
  return text;
}

let issuer: { jwk: JWK; at: number } | undefined;

/** The credential issuer's public JWK, as leg A serves it, if its thumbprint is `thumbprint`. */
async function issuerOf(tee: IssueDeps["tee"], thumbprint: string): Promise<JWK> {
  const thumbprintOf = async (jwk: JWK) =>
    `0x${Buffer.from(await calculateJwkThumbprint(jwk, "sha256"), "base64url").toString("hex")}`;
  if (
    issuer &&
    Date.now() - issuer.at < 600_000 &&
    (await thumbprintOf(issuer.jwk)) === thumbprint
  ) {
    return issuer.jwk;
  }
  if (!tee) throw new AlibiIssueError("config", "no TEE leg to read the credential issuer from");
  const health = (await tee.client.a.health()) as { issuer?: JWK };
  if (!health.issuer) throw new Error("leg a serves no credential issuer");
  issuer = { jwk: health.issuer, at: Date.now() };
  if ((await thumbprintOf(issuer.jwk)) !== thumbprint.toLowerCase()) {
    throw new AlibiIssueError("issuer", "leg a's issuer is not the one the signer attests");
  }
  return issuer.jwk;
}

const json = (v: unknown) => v as Record<string, Json>;

/** How long a purchase's Alibi waits for leg A's C1 proof before it is issued without one. */
const C1_GRACE_MS = 60_000;

type C1Proof = NonNullable<(typeof purchases.$inferSelect)["c1Proof"]>;

/**
 * The purchase's C1 proof. Leg A answers the countersign first and proves after, so a proof not
 * stored yet is fetched from it and stored; `null` when the ALLOW has none.
 */
async function c1Of(
  deps: IssueDeps,
  p: typeof purchases.$inferSelect,
  provable: boolean,
): Promise<C1Proof | null> {
  if (p.c1Proof || !provable || !deps.tee) return p.c1Proof ?? null;
  let proof: C1Proof | null;
  try {
    proof = await deps.tee.client.a.c1(p.id);
  } catch (err) {
    // The proof is optional; past the grace the Alibi is issued without it so the purchase is
    // captured.
    const age = Date.now() - Number(p.countersign?.issuedAt ?? 0) * 1000;
    if (age < C1_GRACE_MS) throw err;
    deps.log.warn({ err, purchaseId: p.id }, "alibi issued without its C1 proof");
    return null;
  }
  if (proof) {
    await deps.db.update(purchases).set({ c1Proof: proof }).where(eq(purchases.id, p.id));
  }
  return proof;
}

/** How long a new mandate's Alibis wait for its C3 proof and root before they are issued without them. */
const C3_GRACE_MS = 60_000;

type C3Entry = NonNullable<NonNullable<AlibiBundle["zk"]>["c3"]>;

/**
 * The mandate's C3 proof with the transaction that published its root, once both exist. A mandate
 * whose salt leg A sealed is proved and its root published within seconds of its signing, so
 * until the grace has passed a missing one throws and the Alibi is issued on a later attempt.
 */
async function c3Of(
  deps: IssueDeps,
  m: typeof mandates.$inferSelect,
  chainId: number,
): Promise<C3Entry | null> {
  let entry: C3Entry | null = null;
  const root = m.c3Proof?.public_inputs[2];
  if (m.c3Proof && root) {
    const [tx] = await deps.db
      .select({ hash: chainTxs.hash })
      .from(chainTxs)
      .where(
        and(
          eq(chainTxs.chainId, chainId),
          eq(chainTxs.key, rootKey(root)),
          eq(chainTxs.status, "confirmed"),
        ),
      );
    // The recursive proof feeds the composed proof only; the Alibi carries the EVM one.
    const { recursive_proof: _, ...c3 } = m.c3Proof;
    if (tx?.hash) entry = { ...c3, root_tx: toHex(tx.hash) };
  }
  if (entry || m.sealedSalt === null) return entry;
  if (Date.now() - m.createdAt.getTime() < C3_GRACE_MS) {
    throw new Error(`mandate ${m.id} has no published C3 proof yet`);
  }
  deps.log.warn({ mandateId: m.id }, "alibi issued without its C3 proof");
  return null;
}

/**
 * Issues the Alibi of a logged purchase: the immutable core of its bundle, built from what
 * Postgres holds and the log's answer for its leaf, stored once. Opening the public evidence
 * items for it is recorded in `evidence_access`. A purchase that already has an Alibi is left as
 * it is.
 *
 * @throws {AlibiIssueError} when the log's leaf is not the purchase's or the bundle is too large.
 */
export async function issueAlibi(deps: IssueDeps, input: IssueInput): Promise<void> {
  const { db } = deps;
  const { purchaseId, append } = input;
  const { merchantId } = deps;
  if (!merchantId) throw new AlibiIssueError("config", "no PayPal merchant id to bind invoices to");
  const [existing] = await db
    .select({ id: alibis.purchaseId })
    .from(alibis)
    .where(eq(alibis.purchaseId, purchaseId));
  if (existing) return;

  const out = await countersignOf(db, purchaseId);
  const leaf = await purchaseLeaf(db, purchaseId, out);
  const hash = leafHash(leaf);
  if (toHex(hash) !== toHex(append.leafHash)) {
    throw new AlibiIssueError("leaf", "the logged leaf is not the purchase's");
  }
  const [p] = await db.select().from(purchases).where(eq(purchases.id, purchaseId));
  if (!p?.evalTrace || !p.paypalRefSalt || !p.paypalOrderId || !p.paypalAuthorizationId) {
    throw new AlibiIssueError("data", `purchase ${purchaseId} has no trace or PayPal reference`);
  }
  const [m] = await db.select().from(mandates).where(eq(mandates.id, p.mandateId));
  if (!m?.openMandate || !m.payloadSd || !m.disclosures || !m.userAuth || !m.mandateHash) {
    throw new AlibiIssueError("data", `mandate ${p.mandateId} is not signed`);
  }
  const chainId = p.chainId ?? 421614;
  const origin = LOG_ORIGINS[chainId];
  const env = ENV[chainId];
  if (!origin || !env) throw new AlibiIssueError("data", `${purchaseId} is on an unknown chain`);

  const c = out.countersign;
  const addresses = [out.signers.tdx, out.signers.nitro].filter((a) => a !== null);
  const signerRows = await db
    .select()
    .from(teeSigners)
    .where(
      inArray(
        teeSigners.address,
        addresses.map((a) => Buffer.from(a.slice(2), "hex")),
      ),
    );
  const attestations = addresses.map((a) => {
    const r = signerRows.find((s) => getAddress(toHex(s.address)) === a);
    if (!r) throw new AlibiIssueError("data", `signer ${a} is not admitted`);
    return {
      kind: KIND[r.teeKind as 1 | 2],
      signer: a,
      measurement: r.measurement,
      binding: json(r.binding),
      document: r.attestation as Json,
    };
  });
  const thumbprint = (attestations[0]?.binding as { issuerJwkThumbprint?: string } | undefined)
    ?.issuerJwkThumbprint;
  if (!thumbprint) throw new AlibiIssueError("issuer", "the TDX attestation binds no issuer");
  const [issuerJwk, policyText, evidence, c1, c3] = await Promise.all([
    span("alibi.issuer", {}, () => issuerOf(deps.tee, thumbprint)),
    span("alibi.policy", {}, () => policyOf(origin)),
    span("alibi.evidence", {}, () => disclosures(db, Buffer.from(c.evidenceRoot.slice(2), "hex"))),
    span("alibi.c1", {}, () => c1Of(deps, p, c.decision === "1" && m.sealedSalt !== null)),
    span("alibi.c3", {}, () => c3Of(deps, m, chainId)),
  ]);

  let customId: string;
  if (m.holdMode === "per_purchase") {
    const [h] = await db
      .select()
      .from(purchaseHolds)
      .where(eq(purchaseHolds.requestId, purchaseId));
    if (!h) throw new AlibiIssueError("data", `purchase ${purchaseId} has no hold`);
    customId = purchaseHoldCustomId(
      env,
      purchaseId,
      purchaseHoldDigest({
        mandateHash: m.mandateHash,
        cartHash: h.cartHash,
        merchantId: h.merchantId,
        amount: { currency: h.currency as never, minor: h.amountMinor },
      }),
    );
  } else {
    customId = holdCustomId(env, m.id, m.mandateHash);
  }

  const text = new TextDecoder().decode(leaf);
  const bundle: AlibiBundle = {
    type: ALIBI_MEDIA_TYPE,
    alibi_id: purchaseId,
    leaf: toBase64(leaf),
    leaf_view: JSON.parse(text.slice(LEAF_PREFIX.length)),
    tlog_proof: append.proof,
    policy: { origin, text: policyText },
    timestamps: [],
    tee: {
      domain: {
        name: "Keelson",
        version: "1",
        chain_id: chainId,
        verifying_contract: VERIFYING_CONTRACT,
      },
      countersign: Object.fromEntries(
        Object.entries(c).map(([k, v]) => [k, v.startsWith("0x") ? v.toLowerCase() : v]),
      ) as AlibiBundle["tee"]["countersign"],
      digest: out.digest.toLowerCase(),
      mode: out.mode,
      signatures: [
        {
          kind: "tdx" as const,
          signer: out.signers.tdx,
          signature: out.signatures.tdx.toLowerCase(),
        },
        ...(out.signers.nitro && out.signatures.nitro
          ? [
              {
                kind: "nitro" as const,
                signer: out.signers.nitro,
                signature: out.signatures.nitro.toLowerCase(),
              },
            ]
          : []),
      ],
      attestations,
    },
    eval: p.evalTrace as AlibiBundle["eval"],
    mandate: {
      sd_jwt: m.openMandate,
      disclosures: m.disclosures,
      payload_sd: json(m.payloadSd),
      // The assertion as the open mandate signs it: the stored one also keeps credentialId and userHandle.
      user_auth: userAuthOf(m.userAuth),
      issuer_jwk: json(issuerJwk),
    },
    manifest: { public: evidence.manifest, disclosures: evidence.disclosures },
    ...(evidence.cart ? { cart: evidence.cart } : {}),
    ...(evidence.observation ? { channel3_observation: evidence.observation } : {}),
    ...(evidence.webFact ? { web_fact: evidence.webFact } : {}),
    ...(evidence.checkout ? { checkout: evidence.checkout } : {}),
    ...(c1 || c3
      ? {
          zk: {
            ...(c1 ? { c1: { proof: c1.proof, public_inputs: c1.public_inputs } } : {}),
            ...(c3 ? { c3 } : {}),
          },
        }
      : {}),
    paypal: {
      order_id: p.paypalOrderId,
      authorization_id: p.paypalAuthorizationId,
      custom_id: customId,
      ref_salt: toHex(p.paypalRefSalt),
      merchant_id: merchantId,
    },
  };
  let bytes: Uint8Array;
  try {
    bytes = encodeAlibi(bundle);
  } catch (err) {
    throw new AlibiIssueError("format", err instanceof Error ? err.message : String(err));
  }
  if (bytes.length > MAX_ALIBI_BYTES) {
    throw new AlibiIssueError("size", `the bundle is ${bytes.length} bytes`);
  }
  const report = await span("alibi.verify", {}, () => verifyAlibi(bundle));
  const failed = report.checks.filter((c) => c.status === "fail");
  if (failed.length > 0) {
    throw new AlibiIssueError(
      "verify",
      failed.map((c) => `${c.id}: ${c.reason ?? "fail"}`).join("; "),
    );
  }
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(alibis)
      .values({ purchaseId, leafHash: Buffer.from(hash), bundle })
      .onConflictDoNothing()
      .returning({ id: alibis.purchaseId });
    if (inserted.length === 0) return;
    if (evidence.opened.length > 0) {
      await tx.insert(evidenceAccess).values(
        evidence.opened.map((index) => ({
          root: evidence.root,
          index,
          client: "keelson",
          action: "disclose",
          reason: "alibi",
        })),
      );
    }
  });
  deps.log.info({ purchaseId, bytes: bytes.length }, "alibi issued");
}

/**
 * The public manifest, the disclosures of the public items, the cart, the Channel3 observation
 * and the WebFact.
 */
async function disclosures(db: Db, root: Buffer) {
  const [b] = await db.select().from(evidenceBundles).where(eq(evidenceBundles.root, root));
  if (!b) throw new AlibiIssueError("data", "the purchase's evidence bundle is not stored");
  const manifest = b.manifest as Manifest;
  const items = await db
    .select({
      index: evidenceItems.index,
      type: evidenceItems.type,
      mediaType: evidenceItems.mediaType,
      contentHash: evidenceItems.contentHash,
      salt: evidenceItems.salt,
      bytes: evidenceItems.bytes,
    })
    .from(evidenceItems)
    .where(and(eq(evidenceItems.root, root), inArray(evidenceItems.type, [...DISCLOSED])))
    .orderBy(asc(evidenceItems.index));
  const leaves = manifest.items.map((i) => Buffer.from(i.leaf.slice(2), "hex"));
  const out = items.map((i) => ({
    index: i.index,
    type: i.type,
    media_type: i.mediaType,
    content_hash: toHex(i.contentHash),
    salt: toHex(i.salt),
    path: inclusionPath(leaves, i.index).map((x) => toHex(x)),
    size: leaves.length,
  }));
  const c3 = items.find((i) => i.type === "channel3.observation");
  let observation: Record<string, Json> | undefined;
  if (c3) {
    const [o] = await db
      .select({ document: channel3Observations.document })
      .from(channel3Observations)
      .where(eq(channel3Observations.contentHash, c3.contentHash));
    observation = o ? json(o.document) : undefined;
  }
  const wf = items.find((i) => i.type === "tlsn.web_fact");
  const webFact = wf?.bytes ? json(JSON.parse(Buffer.from(wf.bytes).toString())) : undefined;
  const ct = items.find((i) => i.type === "api.cart");
  const cart = ct?.bytes ? json(JSON.parse(Buffer.from(ct.bytes).toString())) : undefined;
  const co = items.find((i) => i.type === "api.checkout");
  const checkout = co?.bytes ? json(JSON.parse(Buffer.from(co.bytes).toString())) : undefined;
  return {
    root,
    manifest: manifest as AlibiBundle["manifest"]["public"],
    disclosures: out,
    cart,
    checkout,
    observation,
    webFact,
    opened: items.map((i) => i.index),
  };
}

/**
 * The current version of a purchase's Alibi: the stored core with the sections that arrive later,
 * the RFC 3161 tokens of its leaf, the capture and invoice ids and the anchor. Every earlier
 * section is byte-identical across versions.
 */
export async function loadAlibi(db: Db, purchaseId: string): Promise<AlibiBundle | null> {
  const [row] = await db
    .select({
      bundle: alibis.bundle,
      anchor: alibis.anchor,
      leafHash: alibis.leafHash,
      captureId: purchases.paypalCaptureId,
      invoiceId: purchases.invoiceId,
      transactionId: purchases.paypalTransactionId,
    })
    .from(alibis)
    .innerJoin(purchases, eq(purchases.id, alibis.purchaseId))
    .where(eq(alibis.purchaseId, purchaseId));
  if (!row) return null;
  const tokens = await db
    .select({ tsa: timestamps.tsa, token: timestamps.token })
    .from(timestamps)
    .where(
      and(
        eq(timestamps.hash, row.leafHash),
        eq(timestamps.kind, "leaf"),
        eq(timestamps.status, "stamped"),
      ),
    )
    .orderBy(asc(timestamps.tsa));
  const core = row.bundle as AlibiBundle;
  return alibiSchema.parse({
    ...core,
    ...(core.cart === undefined ? await cartOf(db, core) : {}),
    ...(row.anchor ? { anchor: row.anchor } : {}),
    timestamps: tokens.map((t) => ({ tsa: t.tsa, token: toBase64(t.token as Uint8Array) })),
    paypal: {
      ...core.paypal,
      ...(row.captureId ? { capture_id: row.captureId } : {}),
      ...(row.invoiceId ? { invoice_id: row.invoiceId } : {}),
      ...(row.transactionId ? { transaction_id: row.transactionId } : {}),
    },
  });
}

/** The disclosed cart of an Alibi issued before its bundle carried one. */
async function cartOf(db: Db, b: AlibiBundle): Promise<{ cart?: Record<string, Json> }> {
  if (!b.manifest.disclosures.some((d) => d.type === "api.cart")) return {};
  const [item] = await db
    .select({ bytes: evidenceItems.bytes })
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.root, Buffer.from(b.tee.countersign.evidenceRoot.slice(2), "hex")),
        eq(evidenceItems.type, "api.cart"),
      ),
    );
  return item?.bytes ? { cart: json(JSON.parse(Buffer.from(item.bytes).toString())) } : {};
}

/**
 * The public copy of an Alibi: the mandate presented without the user's login id and risk data.
 * Their digests stay in the signed payload, so the copy verifies as the original does.
 */
export function publicCopy(b: AlibiBundle): AlibiBundle {
  return {
    ...b,
    mandate: {
      ...b.mandate,
      sd_jwt: withholdPersonal(b.mandate.sd_jwt),
      disclosures: b.mandate.disclosures.filter((d) => !isPersonalDisclosure(d)),
    },
  };
}

function userAuthOf(stored: unknown): Record<string, string> {
  const { authenticatorData, clientDataJSON, signature } = stored as Record<string, string>;
  if (!authenticatorData || !clientDataJSON || !signature) {
    throw new AlibiIssueError("format", "the stored passkey assertion is incomplete");
  }
  return { authenticatorData, clientDataJSON, signature };
}
