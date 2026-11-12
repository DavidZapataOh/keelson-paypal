import { randomBytes } from "node:crypto";
import { addresses, keelsonBondVaultAbi } from "@keelson/chain";
import {
  chainEvents,
  eq,
  mandates,
  operators,
  purchases,
  teeSignatures,
  teeSigners,
  user,
} from "@keelson/db";
import type { Relayer, SubmitRequest } from "@keelson/relayer";
import { pino } from "pino";
import { ulid } from "ulid";
import { encodeFunctionData, type Hex, type PublicClient, toHex } from "viem";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import vector from "../../../engine/tee/tests/vectors/countersign-allow.json" with { type: "json" };
import { purchaseOfCoverage } from "../src/chain/amber-court.ts";
import { contestable, contestQueuedSlashes } from "../src/chain/engine-court.ts";
import { CONTRACTS, type EventLog, ingest } from "../src/chain/events.ts";
import { testDb } from "./setup.ts";

const log = pino({ level: "silent" });
const { input, countersign } = vector;
const coverageId = countersign.requestId as Hex;
const purchaseId = purchaseOfCoverage(coverageId) as string;
const digest = `0x${randomBytes(32).toString("hex")}` as Hex;
const userId = `user-${randomBytes(6).toString("hex")}`;
const mandateId = ulid();
const tdx = randomBytes(65);
const nitro = randomBytes(65);
const id = () => `0x${randomBytes(32).toString("hex")}` as Hex;

const verdict = (fieldId: number, ruleId = 61) => ({
  disputeId: id(),
  coverageId,
  agentId: BigInt(countersign.agentId),
  payee: `0x${"44".repeat(20)}` as Hex,
  amount: 940_000n,
  ruleId,
  liable: 1,
  fieldId,
  evidenceHash: id(),
  inputsHash: id(),
  policySetHash: countersign.policySetHash as Hex,
  checkpointRoot: id(),
  issuedAt: 1n,
  deadline: 2n,
});
type Verdict = ReturnType<typeof verdict>;

/** The chain as the follower and the court see it: the `slash` calls and the recorded proofs. */
function chain(proven: Hex) {
  const calls = new Map<Hex, Hex>();
  const client = {
    getTransaction: async ({ hash }: { hash: Hex }) => ({ input: calls.get(hash) }),
    readContract: async ({ args }: { args: [Hex] }) =>
      args[0] === digest ? proven : `0x${"00".repeat(32)}`,
  } as unknown as PublicClient;
  return { client, calls };
}

async function queue(c: ReturnType<typeof chain>, v: Verdict, readyAt = Date.now() / 1000 + 120) {
  const txHash = id();
  c.calls.set(
    txHash,
    encodeFunctionData({ abi: keelsonBondVaultAbi, functionName: "slash", args: [v, 1n, "0x"] }),
  );
  await ingest(
    testDb,
    [
      {
        address: CONTRACTS[0] as Hex,
        blockHash: id(),
        blockNumber: 10n,
        data: "0x",
        logIndex: 0,
        transactionHash: txHash,
        transactionIndex: 0,
        removed: false,
        topics: [],
        eventName: "SlashQueued",
        args: { disputeId: v.disputeId, coverageId, readyAt: BigInt(Math.floor(readyAt)) },
      } as unknown as EventLog,
    ],
    { finalized: false },
  );
  return txHash;
}

const handled = async (txHash: Hex) =>
  (
    await testDb
      .select({ at: chainEvents.handledAt })
      .from(chainEvents)
      .where(eq(chainEvents.txHash, Buffer.from(txHash.slice(2), "hex")))
  )[0]?.at ?? null;

beforeAll(async () => {
  await testDb.insert(user).values({ id: userId, name: "Tester", email: `${userId}@example.test` });
  await testDb
    .insert(operators)
    .values({
      agentId: BigInt(countersign.agentId),
      chainId: 421614,
      agentRegistry: input.payload_sd.agent.operator.agent_registry,
      name: "op",
      cnfJwk: {},
    })
    .onConflictDoNothing();
  await testDb.insert(mandates).values({
    id: mandateId,
    userId,
    operatorAgentId: BigInt(countersign.agentId),
    state: "SIGNED",
    currency: "USD",
    maxMinor: 10_000n,
    remainingMinor: 10_000n,
    merchantIds: [input.cart.merchant],
    expiresAt: new Date(input.expires_at * 1000),
    payloadSd: input.payload_sd,
    disclosures: input.disclosures,
  });
  await testDb.insert(purchases).values({
    id: purchaseId,
    mandateId,
    merchantId: input.cart.merchant,
    currency: input.cart.currency,
    amountMinor: BigInt(countersign.amount),
    cartHash: randomBytes(32),
    countersignDigest: Buffer.from(digest.slice(2), "hex"),
    countersign,
    countersignMode: "2of2",
  });
  for (const [kind, signature] of [
    [1, tdx],
    [2, nitro],
  ] as const) {
    const address = randomBytes(20);
    await testDb.insert(teeSigners).values({
      address,
      teeKind: kind,
      measurement: "m",
      binding: {},
      attestation: {},
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await testDb.insert(teeSignatures).values({
      requestId: purchaseId,
      signer: address,
      digest: Buffer.from(digest.slice(2), "hex"),
      signature,
    });
  }
});

describe("contesting queued slashes with the engine proof", () => {
  const sent: SubmitRequest[] = [];
  const relayer = {
    submit: async (req: SubmitRequest) => {
      sent.push(req);
      return { id: "tx", status: "confirmed" };
    },
  } as unknown as Relayer;
  beforeEach(() => {
    sent.length = 0;
  });

  test("only a field rule on a field no observation decides is contestable", () => {
    expect(contestable({ ruleId: 61, fieldId: 5 })).toBe(true);
    expect(contestable({ ruleId: 60, fieldId: 0 })).toBe(true);
    expect(contestable({ ruleId: 61, fieldId: 3 })).toBe(false);
    expect(contestable({ ruleId: 61, fieldId: 9 })).toBe(false);
    expect(contestable({ ruleId: 0, fieldId: 255 })).toBe(false);
    expect(contestable({ ruleId: 31, fieldId: 5 })).toBe(false);
  });

  test.runIf(addresses[421614].EngineProofCourt)(
    "contests a slash the proven ALLOW contradicts, with the purchase's countersign and signatures",
    async () => {
      const c = chain(countersign.evalHash as Hex);
      const v = verdict(5);
      const tx = await queue(c, v);
      expect(await contestQueuedSlashes({ db: testDb, log, relayer, client: c.client })).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        contract: "EngineProofCourt",
        functionName: "contest",
        key: `EngineProofCourt.contest:${v.disputeId}`,
      });
      const [sentVerdict, sentCountersign, sigs] = (sent[0] as SubmitRequest).args as [
        Verdict,
        { evalHash: Hex },
        Hex,
      ];
      expect(sentVerdict).toEqual(v);
      expect(sentCountersign.evalHash).toBe(countersign.evalHash);
      expect(sigs).toBe(`${toHex(tdx)}${toHex(nitro).slice(2)}`);
      expect(await handled(tx)).not.toBeNull();
    },
  );

  test.runIf(addresses[421614].EngineProofCourt)(
    "waits for the proof, and never contests an observed field or a closed window",
    async () => {
      const unproven = chain(`0x${"00".repeat(32)}`);
      const waiting = await queue(unproven, verdict(5));
      const observed = await queue(unproven, verdict(9));
      const closed = await queue(unproven, verdict(5), Date.now() / 1000 - 1);
      expect(
        await contestQueuedSlashes({ db: testDb, log, relayer, client: unproven.client }),
      ).toBe(0);
      expect(sent).toHaveLength(0);
      expect(await handled(waiting)).toBeNull();
      expect(await handled(observed)).not.toBeNull();
      expect(await handled(closed)).not.toBeNull();
    },
  );
});
