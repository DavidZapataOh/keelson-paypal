import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  attacks,
  desc,
  disputes,
  mandates,
  operators,
  purchases,
  redTeamCampaigns,
  riskCalibrations,
  user,
  verdicts,
} from "@keelson/db";
import { grade, lineHash, priorOf, score } from "@keelson/redteam";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { calibrate } from "../src/risk.ts";
import { testDb, testKv } from "./setup.ts";

const app = createApp({ db: testDb, kv: testKv, log: pino({ level: "silent" }) });

/** A finished campaign on api.keelson.finance, its ledger byte for byte. */
const LEDGER = readFileSync(
  new URL("./redteam-01M72AKHZ75KJSNS17AA9BJTJY.jsonl", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((l) => l !== "");

/** Agent 351's coverages as its `CoverageLocked` logs record them on Arbitrum Sepolia. */
const recorded = JSON.parse(
  readFileSync(new URL("../../redteam/test/coverages-351.json", import.meta.url), "utf8"),
) as { released: number; amountsMinor: number[] };

const agentId = 900_000_000n + BigInt(randomBytes(3).readUIntBE(0, 3));
const covered: string[] = [];

beforeAll(async () => {
  const header = JSON.parse(LEDGER[0] as string) as { campaign: string };
  const last = LEDGER.at(-1) as string;
  await testDb
    .insert(redTeamCampaigns)
    .values({
      id: header.campaign,
      header: LEDGER[0] as string,
      summary: last,
      head: Buffer.from(lineHash(last), "hex"),
      finishedAt: new Date(),
    })
    .onConflictDoNothing();
  await testDb
    .insert(attacks)
    .values(
      LEDGER.slice(1, -1).map((line) => {
        const a = JSON.parse(line) as { seq: number; backbone: string };
        return {
          id: ulid(),
          campaign: header.campaign,
          seq: a.seq,
          backbone: a.backbone,
          payloadHash: Buffer.alloc(32),
          outcome: "NO_EFFECT" as const,
          line,
          hash: Buffer.from(lineHash(line), "hex"),
        };
      }),
    )
    .onConflictDoNothing();

  const owner = `user-${randomBytes(6).toString("hex")}`;
  await testDb.insert(user).values({ id: owner, name: "Tester", email: `${owner}@example.test` });
  await testDb.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "op",
    cnfJwk: {},
  });
  const mandateId = ulid();
  await testDb.insert(mandates).values({
    id: mandateId,
    userId: owner,
    operatorAgentId: agentId,
    state: "ACTIVE",
    currency: "USD",
    maxMinor: 20_000n,
    remainingMinor: 20_000n,
    merchantIds: ["store"],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  // The recorded coverages, released clean as the reputation registry rated them.
  const rows = recorded.amountsMinor.slice(0, recorded.released).map((amount) => ({
    id: ulid(),
    mandateId,
    state: "SETTLED" as const,
    merchantId: "store",
    currency: "USD",
    amountMinor: BigInt(amount),
    cartHash: randomBytes(32),
  }));
  for (let i = 0; i < rows.length; i += 200) {
    await testDb.insert(purchases).values(rows.slice(i, i + 200));
  }
  covered.push(...rows.map((r) => r.id));
});

/** A verdict with the operator at fault, paid from its bond. */
async function slash(purchaseId: string): Promise<void> {
  const disputeId = `PP-D-${randomBytes(6).toString("hex")}`;
  await testDb.insert(disputes).values({
    id: disputeId,
    purchaseId,
    state: "RESOLVED",
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    ruleId: 61,
    liable: 1,
    raw: {},
  });
  await testDb.insert(verdicts).values({
    id: ulid(),
    disputeId,
    liable: 1,
    ruleId: 61,
    amountMinor: 5n,
    currency: "USD",
    payee: "0x467D2beBb479D9B80Ab1c461243E05A2b82387d8",
    digest: randomBytes(32),
    chainId: 421614,
    message: { ruleId: "61", liable: "1" },
    signatures: [],
    facts: {},
    outcome: "paid",
    paidBy: "chain",
    settledAt: new Date(),
  });
}

type Body = ReturnType<typeof grade> & {
  agentId: string;
  computedAt: string;
  calibration: { id: string; campaigns: string[] };
  evidence: { coverages: number; incidents: Record<string, number> };
};

async function read(): Promise<Body> {
  const res = await app.request(`/v1/operators/${agentId}/grade`);
  expect(res.status).toBe(200);
  expect(res.headers.get("server-timing")).toMatch(/^grade;dur=[\d.]+, model;dur=[\d.]+$/);
  return (await res.json()) as Body;
}

/** The grade the pure model gives the stored record under the stored calibration. */
async function expected(incidents: number, lossRatios: number[]) {
  const [c] = await testDb
    .select()
    .from(riskCalibrations)
    .orderBy(desc(riskCalibrations.createdAt))
    .limit(1);
  const id = c?.id as string;
  const amounts = recorded.amountsMinor.slice(0, recorded.released).reverse();
  return {
    id,
    g: grade(
      priorOf([score(LEDGER)]),
      {
        incidents,
        coverages: recorded.released,
        horizon: recorded.released,
        amountsMinor: amounts,
        lossRatios,
      },
      `${agentId}:${id}`,
    ),
  };
}

test("an operator's grade is the model on its recorded coverages under the red team's prior", async () => {
  const body = await read();
  const { id, g } = await expected(0, []);
  expect(body).toMatchObject({ v: "keelson.grade/1", agentId: String(agentId), ...g });
  expect(body.calibration).toMatchObject({ id, campaigns: ["01M72AKHZ75KJSNS17AA9BJTJY"] });
  expect(body.evidence).toEqual({
    coverages: recorded.released,
    incidents: { total: 0, slashes: 0, warranties: 0, uncollected: 0, pending: 0 },
  });
  // Unchanged record, unchanged grade: served without recomputing.
  expect((await read()).computedAt).toBe(body.computedAt);
});

test("a verdict against the operator updates its grade, live", async () => {
  const before = await read();
  const res = await app.request(`/v1/operators/${agentId}/grade/stream`);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const grades: Body[] = [];
  let buffer = "";
  const deadline = Date.now() + 10_000;
  let slashed = false;
  while (grades.length < 2 && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const frame = buffer.slice(0, end).split("\n");
      buffer = buffer.slice(end + 2);
      if (!frame.includes("event: grade")) continue;
      const data = frame
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim() as string;
      grades.push(JSON.parse(data) as Body);
    }
    if (grades.length === 1 && !slashed) {
      slashed = true;
      await slash(covered[0] as string);
    }
  }
  await reader.cancel();
  expect(grades[0]?.computedAt).toBe(before.computedAt);
  const after = grades[1] as Body;
  expect(after.evidence.incidents).toMatchObject({ total: 1, slashes: 1, pending: 0 });
  expect(after.frequency.upper95_ppm).toBeGreaterThan(before.frequency.upper95_ppm);
  expect(after.premium.modelBps).toBeGreaterThanOrEqual(before.premium.modelBps);
  expect(after).toMatchObject((await expected(1, [])).g);
});

test("the nightly calibration reads the verdicts' loss ratios", async () => {
  const c = await calibrate(testDb);
  expect(c?.prior.campaigns).toEqual(["01M72AKHZ75KJSNS17AA9BJTJY"]);
  // The slash paid 5 cents of the first covered purchase.
  expect(c?.lossRatios).toEqual([Math.min(1, 5 / (recorded.amountsMinor[0] as number))]);
  const body = await read();
  expect(body.calibration.id).toBe(c?.id);
  expect(body).toMatchObject((await expected(1, c?.lossRatios ?? [])).g);
});

test("an unknown or malformed operator is refused", async () => {
  expect((await app.request("/v1/operators/1/grade")).status).toBe(404);
  expect((await app.request("/v1/operators/1/grade/stream")).status).toBe(404);
  expect((await app.request("/v1/operators/x/grade")).status).toBe(422);
});
