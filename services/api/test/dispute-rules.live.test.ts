import { writeFileSync } from "node:fs";
import { addresses, checkpointAnchorAbi, iVerdictVerifierAbi } from "@keelson/chain";
import { KEELSON_TYPES } from "@keelson/core/eip712";
import {
  concat,
  createPublicClient,
  encodeAbiParameters,
  type Hex,
  http,
  keccak256,
  toHex,
} from "viem";
import { arbitrumSepolia } from "viem/chains";
import { beforeAll, describe, expect, test } from "vitest";
import { responsePlan } from "../src/disputes/evidence.ts";
import { SETTLEMENT } from "../src/merchants.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg, type TeeConfig } from "../src/tee/signers.ts";
import { verdict2of2 } from "../src/tee/verdict.ts";
import { testDb } from "./setup.ts";

const live = process.env.KEELSON_LIVE === "1" && Boolean(process.env.TEE_A_URL);
/** A live coverage and a block right after it was locked: the verdicts are recorded for a fork there. */
const coverage = process.env.RULES_COVERAGE as Hex | undefined;
const forkBlock = process.env.RULES_BLOCK ? BigInt(process.env.RULES_BLOCK) : undefined;
const LOG_ORIGIN: Hex = "0xe0c0e434acc96fa35fb684556f51efd752a89b3db13536efbf1e4a0d85e800d9";
const chain = addresses[421614];

const clean = {
  proof_valid: true,
  failed_green: false,
  failed_amber: false,
  failed_gray: false,
  captured_eq_countersigned: true,
  duplicate_countersig: false,
  duplicate_capture: false,
  tracking_delivered: false,
  snapshot_matches_item: true,
  refund_recorded: false,
};

/** One dispute per rule of the attribution table, with the party and PayPal action it implies. */
const RULES = [
  { rule: 0, liable: 1, action: "accept", facts: { reason: "UNAUTHORISED", proof_valid: false } },
  {
    rule: 10,
    liable: 4,
    action: "contest",
    facts: { reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", tracking_delivered: true },
  },
  {
    rule: 11,
    liable: 3,
    action: "contest",
    facts: { reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" },
  },
  {
    rule: 20,
    liable: 4,
    action: "contest",
    facts: { reason: "CREDIT_NOT_PROCESSED", refund_recorded: true },
  },
  { rule: 21, liable: 3, action: "contest", facts: { reason: "CREDIT_NOT_PROCESSED" } },
  {
    rule: 30,
    liable: 2,
    action: "accept",
    facts: { reason: "DUPLICATE_TRANSACTION", duplicate_countersig: true },
  },
  {
    rule: 31,
    liable: 1,
    action: "accept",
    facts: { reason: "DUPLICATE_TRANSACTION", duplicate_capture: true },
  },
  { rule: 32, liable: 4, action: "contest", facts: { reason: "DUPLICATE_TRANSACTION" } },
  { rule: 35, liable: 3, action: "contest", facts: { reason: "PAYMENT_BY_OTHER_MEANS" } },
  {
    rule: 40,
    liable: 3,
    action: "contest",
    facts: { reason: "INCORRECT_AMOUNT", captured_eq_countersigned: false },
  },
  {
    rule: 50,
    liable: 3,
    action: "contest",
    facts: { reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", snapshot_matches_item: false },
  },
  {
    rule: 60,
    liable: 2,
    action: "accept",
    facts: { reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", failed_green: true },
  },
  { rule: 61, liable: 1, action: "accept", facts: { reason: "UNAUTHORISED", failed_amber: true } },
  { rule: 62, liable: 4, action: "contest", facts: { reason: "OTHER", failed_gray: true } },
  { rule: 70, liable: 4, action: "contest", facts: { reason: "UNAUTHORISED" } },
] as const;

const verdictType = {
  type: "tuple",
  components: KEELSON_TYPES.Verdict.map((f) => ({ name: f.name, type: f.type })),
} as const;

describe.skipIf(!live)("every attribution rule on the live legs", { timeout: 300_000 }, () => {
  const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL as string;
  const client = createPublicClient({ chain: arbitrumSepolia, transport: http(rpc) });
  let tee: TeeConfig;
  let at: { treeSize: bigint; root: Hex; time: number };

  beforeAll(async () => {
    tee = createTee(
      {
        TEE_A_URL: process.env.TEE_A_URL as string,
        TEE_B_URL: process.env.TEE_B_URL as string,
        KEELSON_TEE_TOKEN: process.env.KEELSON_TEE_TOKEN as string,
        ARBITRUM_SEPOLIA_RPC_URL: rpc,
      },
      // From outside Render, leg B is further away than the countersign budget allows.
      { a: 10_000, b: 10_000 },
    );
    await refreshLeg(testDb, "a", tee);
    await refreshLeg(testDb, "b", tee);
    const blockNumber = forkBlock ?? (await client.getBlockNumber());
    const [treeSize, root] = await client.readContract({
      address: chain.CheckpointAnchor as Hex,
      abi: checkpointAnchorAbi,
      functionName: "latest",
      args: [LOG_ORIGIN],
      blockNumber,
    });
    at = { treeSize, root, time: Number((await client.getBlock({ blockNumber })).timestamp) };
  });

  test("each rule names its party, both legs sign it and the chain accepts the signatures", async () => {
    const vectors = [];
    const timings: number[] = [];
    for (const r of RULES) {
      const facts = { ...clean, ...r.facts };
      const started = performance.now();
      const signed = await verdict2of2(
        { db: testDb, tee },
        {
          facts,
          input: {
            paypal_dispute_id: `PP-R-RULE-R${String(r.rule).padStart(2, "0")}`,
            coverage_id: coverage ?? keccak256(toHex(`coverage R${r.rule}`)),
            agent_id: "351",
            payee: SETTLEMENT.mrc_runfast as Hex,
            // Five verdicts pay out of one 2 PYUSD coverage: R00, R31, R61, R30 and R60.
            amount: "400000",
            failed_fields: { green: 3, amber: 9, gray: 28 },
            evidence_hash: keccak256(toHex(`evidence R${r.rule}`)),
            checkpoint_root: at.root,
            issued_at: at.time,
            deadline: at.time + 3_600,
          },
          chain_id: 421614,
        },
      );
      timings.push(performance.now() - started);
      expect(Number(signed.message.ruleId), `R${r.rule}`).toBe(r.rule);
      expect(Number(signed.message.liable), `R${r.rule}`).toBe(r.liable);
      // A refund dispute's evidence names the order's refund.
      const order = { purchaseUnits: [{ payments: { refunds: [{ id: "REFUND" }] } }] };
      expect(responsePlan({ ruleId: r.rule, liable: r.liable }, order).action).toBe(r.action);
      const sig = (tee: number) => signed.signatures.find((s) => s.tee === tee)?.signature as Hex;
      const sigs = concat([sig(1), sig(2)]);
      expect(
        await client.readContract({
          address: chain.VerdictVerifier as Hex,
          abi: iVerdictVerifierAbi,
          functionName: "verify2of2",
          args: [signed.digest, sigs],
        }),
        `R${r.rule}`,
      ).toBe(true);
      const m = signed.message;
      vectors.push({
        rule: r.rule,
        liable: r.liable,
        digest: signed.digest,
        verdict: encodeAbiParameters(
          [verdictType],
          [
            {
              disputeId: m.disputeId as Hex,
              coverageId: m.coverageId as Hex,
              agentId: BigInt(m.agentId),
              payee: m.payee as Hex,
              amount: BigInt(m.amount),
              ruleId: Number(m.ruleId),
              liable: Number(m.liable),
              fieldId: Number(m.fieldId),
              evidenceHash: m.evidenceHash as Hex,
              inputsHash: m.inputsHash as Hex,
              policySetHash: m.policySetHash as Hex,
              checkpointRoot: m.checkpointRoot as Hex,
              issuedAt: Number(m.issuedAt),
              deadline: Number(m.deadline),
            },
          ],
        ),
        signatures: sigs,
      });
    }
    timings.sort((a, b) => a - b);
    console.info(
      `2-of-2 verdict per rule: p50 ${Math.round(timings[7] as number)} ms, max ${Math.round(timings[14] as number)} ms`,
    );
    if (coverage && forkBlock !== undefined) {
      writeFileSync(
        new URL("../../../contracts/test/vectors/verdicts-live.json", import.meta.url),
        `${JSON.stringify({ block: Number(forkBlock), treeSize: Number(at.treeSize), coverageId: coverage, verdicts: vectors }, null, 2)}\n`,
      );
    }
  });
});
