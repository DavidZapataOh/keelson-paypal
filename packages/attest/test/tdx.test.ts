import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { AttestError } from "../src/errors.ts";
import { type DstackEvent, replayRtmr3 } from "../src/eventlog.ts";
import { getCollateral } from "../src/server/collateral.ts";
import { acceptTcbStatus, verifyTdx } from "../src/tdx.ts";
import { tdxEvidence } from "./evidence.ts";

const att = tdxEvidence.attestation;
const quote = Buffer.from(att.quote, "hex");
const now = new Date(tdxEvidence.capturedAt);
const input = (overrides: Partial<{ quote: Uint8Array; eventLog: DstackEvent[] }> = {}) => ({
  quote,
  eventLog: att.event_log,
  collateral: tdxEvidence.collateral,
  ...overrides,
});
type Tdx = { tdx: { app_id: string; compose_hash: string } };
const read = <T>(path: string) =>
  JSON.parse(readFileSync(new URL(`../../../engine/tee/${path}`, import.meta.url), "utf8")) as T;
// The published build the captured leg runs: the current one, or during a rotation the previous one.
const published = [read<Tdx>("measurements.json"), ...read<Tdx[]>("measurements-rotation.json")];
const builds = published.map((m) => m.tdx);

const codeOf = async (p: Promise<unknown>) => {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AttestError);
  return (error as AttestError).code;
};

describe("verifyTdx", () => {
  test("verifies the captured quote with its collateral", async () => {
    const result = await verifyTdx(input(), { now });
    expect(result.tcbStatus).toBe("UpToDate");
    expect(result.advisoryIds).toEqual([]);
    expect(result.reportData).toMatch(/^0x[0-9a-f]{128}$/);
    expect(result.mrtd).toMatch(/^0x[0-9a-f]{96}$/);
    expect(result.rtmr).toHaveLength(4);
    expect(builds.map((m) => `0x${m.app_id}`)).toContain(result.appId);
    expect(result.osImageHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.keyProvider).toContain('"name":"kms"');
  });

  test("binds the compose hash recorded for the deployment", async () => {
    const result = await verifyTdx(input(), { now });
    const build = builds.find((m) => `0x${m.app_id}` === result.appId);
    expect(result.composeHash).toBe(`0x${build?.compose_hash}`);
  });

  test("replays RTMR3 to the value in the quote", async () => {
    const result = await verifyTdx(input(), { now });
    expect(await replayRtmr3(att.event_log)).toBe(result.rtmr[3]);
  });

  test("rejects collateral past its next update", async () => {
    const later = new Date(now.getTime() + 60 * 24 * 3600 * 1000);
    expect(await codeOf(verifyTdx(input(), { now: later }))).toBe("collateral_expired");
  });

  test("rejects a flipped quote signature byte", async () => {
    const changed = Buffer.from(quote);
    // header (48) + TD report (584) + signature data length (4)
    changed[636] = (changed[636] ?? 0) ^ 1;
    expect(await codeOf(verifyTdx(input({ quote: changed }), { now }))).toBe("signature");
  });

  test("rejects an event whose payload changed", async () => {
    const eventLog = att.event_log.map((e) =>
      e.event === "compose-hash" ? { ...e, event_payload: "00".repeat(32) } : e,
    );
    expect(await codeOf(verifyTdx(input({ eventLog }), { now }))).toBe("rtmr3_mismatch");
  });

  test("rejects a changed event whose digest was recomputed", async () => {
    const eventLog = att.event_log.map((e) => {
      if (e.event !== "compose-hash") return e;
      const payload = Buffer.alloc(32);
      const type = Buffer.alloc(4);
      type.writeUInt32LE(e.event_type);
      const digest = createHash("sha384")
        .update(type)
        .update(`:${e.event}:`)
        .update(payload)
        .digest("hex");
      return { ...e, event_payload: payload.toString("hex"), digest };
    });
    expect(await codeOf(verifyTdx(input({ eventLog }), { now }))).toBe("rtmr3_mismatch");
  });

  test("rejects an event log with an event removed", async () => {
    const eventLog = att.event_log.filter((e) => e.event !== "gpu-policy-hash");
    expect(await codeOf(verifyTdx(input({ eventLog }), { now }))).toBe("rtmr3_mismatch");
  });
});

describe("acceptTcbStatus", () => {
  test("accepts UpToDate, and SWHardeningNeeded only with advisory ids", () => {
    expect(() => acceptTcbStatus("UpToDate", [])).not.toThrow();
    expect(() => acceptTcbStatus("SWHardeningNeeded", ["INTEL-SA-00837"])).not.toThrow();
    for (const status of ["SWHardeningNeeded", "OutOfDate", "ConfigurationNeeded", "Revoked"]) {
      expect(() => acceptTcbStatus(status, [])).toThrow(AttestError);
    }
  });
});

describe.skipIf(!process.env.KEELSON_LIVE)("live leg A", () => {
  test("verifies the current attestation with fresh collateral", async () => {
    const url = process.env.TEE_A_URL;
    if (!url) throw new Error("TEE_A_URL is not set");
    const body = (await (await fetch(new URL("/v1/attestation", url))).json()) as typeof att;
    const live = Buffer.from(body.quote, "hex");
    const collateral = await getCollateral(live);
    const result = await verifyTdx(
      { quote: live, eventLog: body.event_log, collateral },
      { now: new Date() },
    );
    expect(result.tcbStatus).toMatch(/^(UpToDate|SWHardeningNeeded)$/);
    expect(result.composeHash).toBe(`0x${body.compose_hash}`);
  });
});
