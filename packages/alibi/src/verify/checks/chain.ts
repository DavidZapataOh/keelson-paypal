import { deploymentsFor } from "@keelson/chain";
import { LOG_ORIGINS } from "@keelson/log";
import { getAddress, type Hex, keccak256, stringToBytes } from "viem";
import type { AlibiBundle, AlibiReceipt } from "../../schema.ts";
import type { ChainAnswer, ChainQuery } from "../chain.ts";
import { type CheckDef, type Context, expect, type Outcome, pass } from "../check.ts";
import { OFFLINE } from "../report.ts";
import { isBundle, measurementHex, pinnedOrigin, proofCheckpoint, UNDISCLOSED } from "./util.ts";

const TEE_KIND = { tdx: 1, nitro: 2 } as const;

/** The chain an Alibi's anchor and signers live on: the anchor's, else its countersign domain's. */
export function chainIdOf(input: AlibiBundle | AlibiReceipt): number | undefined {
  if (input.anchor) return input.anchor.chain_id;
  if (isBundle(input)) return input.tee.domain.chain_id;
  const origin = pinnedOrigin(proofCheckpoint(input.tlog_proof));
  const id = Object.entries(LOG_ORIGINS).find(([, o]) => o === origin)?.[0];
  return id === undefined ? undefined : Number(id);
}

/** The one chain query of a verification, from pinned addresses and what the Alibi states. */
export function queryOf(input: AlibiBundle | AlibiReceipt, chainId: number): ChainQuery {
  const d = deploymentsFor(chainId);
  const anchor = d.CheckpointAnchor;
  const verifier = d.VerdictVerifier;
  if (!anchor || !verifier) throw new RangeError(`Keelson has no anchor on chain ${chainId}`);
  const origin = pinnedOrigin(proofCheckpoint(input.tlog_proof));
  const atts = isBundle(input) ? input.tee.attestations : [];
  return {
    origin: keccak256(stringToBytes(origin)),
    size: input.anchor ? BigInt(input.anchor.anchored_size) : 0n,
    signers: atts.map((a) => getAddress(a.signer)),
    measurements: atts.map((a) => measurementHex(a.measurement)),
    blocks: atts.map((a) =>
      BigInt((a.document as { block: { number: number | string } }).block.number),
    ),
    ...(input.anchor
      ? { anchorTx: input.anchor.tx_hash as Hex, anchorBlock: BigInt(input.anchor.block_number) }
      : {}),
    anchor,
    verifier,
  };
}

/** The chain's answer, or the outcome to report when there is none. */
async function read(ctx: Context): Promise<ChainAnswer | Outcome> {
  if (!ctx.chain) return { status: "pending", reason: OFFLINE };
  try {
    return await ctx.chain;
  } catch (err) {
    return { status: "unreachable", reason: (err as Error).message };
  }
}

const isAnswer = (a: ChainAnswer | Outcome): a is ChainAnswer => "rpc" in a;
const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Each attested signer is registered in `VerdictVerifier` for its TEE and measurement, by a
 * registration that covers the countersign's `issuedAt` (registrations made after a lapse start
 * anew, so `registeredAt ≤ issuedAt` means it held continuously since).
 */
export const registry: CheckDef = {
  id: "tee.registry",
  step: 3,
  reads: ["/tee/attestations", "/tee/countersign/issuedAt"],
  async run(input, ctx) {
    if (!isBundle(input)) return UNDISCLOSED;
    const a = await read(ctx);
    if (!isAnswer(a)) return a;
    const issuedAt = Number(input.tee.countersign.issuedAt);
    const detail: Record<string, string> = { rpc: a.rpc, rpc_custom: String(a.custom) };
    const chainReads = ["/anchor/chain_id", "/tee/domain/chain_id"];
    for (const [i, att] of input.tee.attestations.entries()) {
      const at = `/tee/attestations/${i}`;
      const r = a.signers[i];
      const reads = [
        `${at}/signer`,
        `${at}/measurement`,
        "/tee/countersign/issuedAt",
        ...chainReads,
      ];
      expect(r && r.registeredAt > 0, `${att.kind} signer ${att.signer} is not registered`, reads);
      expect(r.teeKind === TEE_KIND[att.kind], `${att.signer} is registered for another TEE`, [
        `${at}/kind`,
        `${at}/signer`,
      ]);
      expect(
        r.measurement === measurementHex(att.measurement),
        `${att.signer} is registered with measurement ${r.measurement}`,
        reads,
      );
      if (r.registeredAt > issuedAt && r.revokedAt === 0) {
        // A registration after a lapse starts anew; the one that covered issuedAt is no longer state.
        return {
          status: "unreachable",
          reason: `${att.signer}'s current registration began at ${iso(r.registeredAt)}, after ${iso(issuedAt)}; the earlier one is not in the chain's state`,
          reads,
        };
      }
      expect(
        r.registeredAt <= issuedAt && issuedAt < r.expiresAt,
        `${att.signer}'s registration (${iso(r.registeredAt)} to ${iso(r.expiresAt)}) does not cover ${iso(issuedAt)}`,
        reads,
      );
      // issuedAt is the signer's own claim, so a revoked key could backdate it: no pass once revoked.
      expect(
        r.revokedAt === 0,
        `${att.signer} was revoked at ${iso(r.revokedAt)}; its issuedAt cannot be trusted`,
        reads,
      );
      const block = (att.document as { block: { number: number | string; hash: string } }).block;
      expect(
        a.blocks[i] === block.hash.toLowerCase(),
        `block ${block.number} on chain is ${a.blocks[i]}, not the attested ${block.hash}`,
        [`${at}/document/block`],
      );
      detail[`${att.kind}_allowed_today`] = String(a.allowed[i]);
    }
    return pass(detail);
  },
};

const latestDetail = (a: ChainAnswer) => ({
  rpc: a.rpc,
  rpc_custom: String(a.custom),
  latest_size: String(a.latest.size),
  latest_at: a.latest.at ? iso(a.latest.at) : "",
});

const UNANCHORED =
  "issued before the checkpoint covering it was anchored; fetch the re-issued Alibi";

/** `CheckpointAnchor.rootAt(origin, anchoredSize)` is the root the Alibi says was anchored. */
export const anchorRoot: CheckDef = {
  id: "anchor.root",
  step: 7,
  reads: ["/anchor/anchored_root", "/anchor/anchored_size", "/anchor/contract", "/tlog_proof"],
  async run(input, ctx) {
    const a = await read(ctx);
    if (!isAnswer(a)) return a;
    const anchor = input.anchor;
    if (!anchor) return { status: "pending", reason: UNANCHORED, detail: latestDetail(a) };
    expect(
      anchor.contract === deploymentsFor(anchor.chain_id).CheckpointAnchor,
      "the anchor contract is not the pinned CheckpointAnchor",
      ["/anchor/contract"],
    );
    expect(
      a.rootAt.toLowerCase() === anchor.anchored_root,
      `the root anchored at size ${anchor.anchored_size} is ${a.rootAt}, not ${anchor.anchored_root}`,
      ["/anchor/anchored_root", "/anchor/anchored_size", "/tlog_proof"],
    );
    return pass(latestDetail(a));
  },
};

/** The anchor transaction emitted `CheckpointAnchored` for this origin, size and root. */
export const anchorTx: CheckDef = {
  id: "anchor.tx",
  step: 7,
  reads: ["/anchor/tx_hash", "/anchor/block_number", "/tlog_proof"],
  async run(input, ctx) {
    const a = await read(ctx);
    if (!isAnswer(a)) return a;
    const anchor = input.anchor;
    if (!anchor) return { status: "pending", reason: UNANCHORED, detail: latestDetail(a) };
    const log = a.anchorLog;
    expect(
      log,
      "the anchor transaction is not on chain or emitted no CheckpointAnchored from the pinned contract",
      ["/anchor/tx_hash"],
    );
    const origin = keccak256(stringToBytes(pinnedOrigin(proofCheckpoint(input.tlog_proof))));
    expect(
      log.origin === origin &&
        log.size === BigInt(anchor.anchored_size) &&
        log.root.toLowerCase() === anchor.anchored_root,
      "the anchor transaction's CheckpointAnchored is of another checkpoint",
      ["/anchor/tx_hash", "/anchor/anchored_size", "/anchor/anchored_root", "/tlog_proof"],
    );
    expect(
      log.blockNumber === BigInt(anchor.block_number),
      `the CheckpointAnchored transaction is in block ${log.blockNumber}, not ${anchor.block_number}`,
      ["/anchor/block_number"],
    );
    return pass({ block_number: String(log.blockNumber) });
  },
};
