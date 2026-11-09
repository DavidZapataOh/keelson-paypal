// Loads reflect-metadata before @keelson/alibi/verify pulls in @keelson/attest (see tee/attest.ts).
import "../src/tee/attest.ts";
import { pino } from "pino";
import { describe, expect, test } from "vitest";
import { DisputeBusyError, type RunDeps, runDispute } from "../src/disputes/run.ts";
import { testDb, testKv } from "./setup.ts";

const deps = { db: testDb, kv: testKv, log: pino({ level: "silent" }) } as unknown as RunDeps;
const lockOf = (id: string) => `dispute:run:${id}`;

describe("runDispute", () => {
  test("a run started while another holds the dispute does nothing", async () => {
    const id = "PP-R-RUN-BUSY";
    await testKv.set(lockOf(id), "another run", { PX: 10_000 });
    // Evaluating would reach the database for a dispute it never stored: it must not get there.
    expect(await runDispute(deps, id)).toEqual({ status: "busy", disputeId: id });
    await expect(runDispute(deps, id, { wait: true })).rejects.toBeInstanceOf(DisputeBusyError);
    expect(await testKv.get(lockOf(id))).toBe("another run");
    await testKv.del(lockOf(id));
  });

  test("a run releases the dispute when it ends, and only its own hold", async () => {
    const id = "PP-R-RUN-FREE";
    expect(await runDispute(deps, id)).toEqual({
      evaluation: { status: "unknown", disputeId: id },
    });
    expect(await testKv.get(lockOf(id))).toBeNull();
  });

  test("runs started together on one dispute: one runs, the other is busy", async () => {
    const id = "PP-R-RUN-RACE";
    const out = await Promise.all([runDispute(deps, id), runDispute(deps, id)]);
    expect(out.filter((o) => "status" in o && o.status === "busy")).toHaveLength(1);
    expect(await testKv.get(lockOf(id))).toBeNull();
  });
});
