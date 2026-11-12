import { randomBytes } from "node:crypto";
import { keelsonBondVaultAbi } from "@keelson/chain";
import { chainEvents, eq } from "@keelson/db";
import { type Relayer, RelayerError, type SubmitRequest } from "@keelson/relayer";
import { pino } from "pino";
import { encodeFunctionData, type Hex, type PublicClient } from "viem";
import { beforeEach, describe, expect, test } from "vitest";
import { contestable, contestQueuedSlashes } from "../src/chain/engine-court.ts";
import { CONTRACTS, type EventLog, ingest } from "../src/chain/events.ts";
import { testDb } from "./setup.ts";

const log = pino({ level: "silent" });
const id = () => `0x${randomBytes(32).toString("hex")}` as Hex;

const verdict = (fieldId: number, ruleId = 61) => ({
  disputeId: id(),
  coverageId: id(),
  agentId: 351n,
  payee: `0x${"44".repeat(20)}` as Hex,
  amount: 940_000n,
  ruleId,
  liable: 1,
  fieldId,
  evidenceHash: id(),
  inputsHash: id(),
  policySetHash: id(),
  checkpointRoot: id(),
  issuedAt: 1,
  deadline: 2,
});
type Verdict = ReturnType<typeof verdict>;

/** The `slash` calls the follower reads verdicts from. */
const calls = new Map<Hex, Hex>();
const client = {
  getTransaction: async ({ hash }: { hash: Hex }) => ({ input: calls.get(hash) }),
} as unknown as PublicClient;

async function queue(v: Verdict, readyAt = Date.now() / 1000 + 120) {
  const txHash = id();
  calls.set(
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
        args: {
          disputeId: v.disputeId,
          coverageId: v.coverageId,
          readyAt: BigInt(Math.floor(readyAt)),
        },
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

describe("contesting queued slashes with the engine proof", () => {
  const sent: SubmitRequest[] = [];
  /** The court's answer to the next contests: a revert name, or none for a veto. */
  let revert: string | undefined;
  const relayer = {
    submit: async (req: SubmitRequest) => {
      sent.push(req);
      if (revert) {
        throw new RelayerError("simulation-reverted", "reverted", { error: { name: revert } });
      }
      return { id: "tx", status: "confirmed" };
    },
  } as unknown as Relayer;
  beforeEach(async () => {
    sent.length = 0;
    revert = undefined;
    await testDb.delete(chainEvents);
  });

  test("only a field rule on a field no observation decides is contestable", () => {
    expect(contestable({ ruleId: 61, fieldId: 5 })).toBe(true);
    expect(contestable({ ruleId: 60, fieldId: 0 })).toBe(true);
    expect(contestable({ ruleId: 61, fieldId: 3 })).toBe(false);
    expect(contestable({ ruleId: 61, fieldId: 9 })).toBe(false);
    expect(contestable({ ruleId: 0, fieldId: 255 })).toBe(false);
    expect(contestable({ ruleId: 31, fieldId: 5 })).toBe(false);
  });

  test("contests a slash the engine proof answers, with the verdict of its slash call", async () => {
    const v = verdict(5);
    const tx = await queue(v);
    expect(await contestQueuedSlashes({ db: testDb, log, relayer, client })).toBe(1);
    expect(sent).toEqual([
      {
        chainId: 421614,
        contract: "EngineProofCourt",
        functionName: "contest",
        args: [v],
        key: `EngineProofCourt.contest:${v.disputeId}`,
      },
    ]);
    expect(await handled(tx)).not.toBeNull();
  });

  test("waits for the countersign and the proof, and gives up on a final revert", async () => {
    revert = "NotProven";
    const waiting = await queue(verdict(5));
    expect(await contestQueuedSlashes({ db: testDb, log, relayer, client })).toBe(0);
    expect(await handled(waiting)).toBeNull();
    revert = "VetoClosed";
    expect(await contestQueuedSlashes({ db: testDb, log, relayer, client })).toBe(0);
    expect(await handled(waiting)).not.toBeNull();
  });

  test("never contests an observed field or a closed window", async () => {
    const observed = await queue(verdict(9));
    const otherRule = await queue(verdict(5, 31));
    const closed = await queue(verdict(5), Date.now() / 1000 - 1);
    expect(await contestQueuedSlashes({ db: testDb, log, relayer, client })).toBe(0);
    expect(sent).toHaveLength(0);
    for (const tx of [observed, otherRule, closed]) expect(await handled(tx)).not.toBeNull();
  });
});
