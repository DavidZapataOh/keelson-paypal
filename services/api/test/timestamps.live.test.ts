import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, timestamps } from "@keelson/db";
import { TSA_INTERMEDIATES, TSA_ROOTS, type TsaId, verifyTimestamp } from "@keelson/timestamp";
import { pino } from "pino";
import { afterEach, describe, expect, test } from "vitest";
import { enqueueStamp, stampsFor } from "../src/timestamps/queue.ts";
import { type StampWorker, startStampWorker } from "../src/timestamps/worker.ts";
import { testDb, testKv } from "./setup.ts";

const live = process.env.KEELSON_LIVE === "1";
const UNREACHABLE = "http://10.255.255.1/";

const errors: unknown[] = [];
const log = pino(
  { level: "warn" },
  { write: (line: string) => void (JSON.parse(line).level >= 50 && errors.push(line)) },
);
const workers: StampWorker[] = [];
function worker(options: Parameters<typeof startStampWorker>[1] = {}): StampWorker {
  const w = startStampWorker({ db: testDb, kv: testKv, log }, options);
  workers.push(w);
  return w;
}
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
  errors.length = 0;
});

const rows = (hash: Uint8Array) =>
  testDb
    .select()
    .from(timestamps)
    .where(eq(timestamps.hash, Buffer.from(hash)));

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function openssl(tsa: TsaId, token: Uint8Array, hash: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "keelson-ts-"));
  writeFileSync(join(dir, "token.der"), token);
  writeFileSync(join(dir, "root.pem"), `${TSA_ROOTS[tsa]}\n`);
  writeFileSync(join(dir, "untrusted.pem"), `${TSA_INTERMEDIATES[tsa] ?? ""}\n`);
  const args = ["ts", "-verify", "-token_in", "-in", join(dir, "token.der")];
  args.push("-digest", Buffer.from(hash).toString("hex"), "-CAfile", join(dir, "root.pem"));
  if (TSA_INTERMEDIATES[tsa]) args.push("-untrusted", join(dir, "untrusted.pem"));
  return execFileSync("openssl", args, { encoding: "utf8" });
}

describe.skipIf(!live)("stamping with the live TSAs", { timeout: 90_000 }, () => {
  test("a hash gets two verified tokens, requested together", async () => {
    const w = worker();
    const hash = randomBytes(32);
    enqueueStamp({ db: testDb, log, stamps: w }, hash, "leaf");

    const stamped = await until(
      () => rows(hash),
      (r) => r.filter((x) => x.status === "stamped").length === 2,
      3_000,
    );
    expect(stamped.map((r) => [r.tsa, r.role, r.status]).sort()).toEqual([
      ["digicert", "primary", "stamped"],
      ["sigstore", "primary", "stamped"],
    ]);
    const starts = [];
    for (const row of stamped) {
      const token = row.token as Buffer;
      const verified = await verifyTimestamp(token, hash);
      expect(verified.tsa).toBe(row.tsa);
      expect(openssl(row.tsa as TsaId, token, hash)).toContain("Verification: OK");
      starts.push((row.stampedAt as Date).getTime() - (row.latencyMs as number));
    }
    expect(Math.abs((starts[0] as number) - (starts[1] as number))).toBeLessThan(50);

    const served = await stampsFor(testDb, hash);
    expect(served.map((s) => s.tsa)).toEqual(["digicert", "sigstore"]);
    expect(Buffer.from(served[0]?.token ?? "", "base64")).toEqual(
      stamped.find((r) => r.tsa === "digicert")?.token,
    );
  });

  test("an unreachable primary is retried by the sweeper, then replaced by its fallback", async () => {
    const w = worker({ urls: { sigstore: UNREACHABLE }, sweepIntervalMs: 1_000 });
    const hash = randomBytes(32);
    enqueueStamp({ db: testDb, log, stamps: w }, hash, "leaf");

    const first = await until(
      () => rows(hash),
      (r) => r.some((x) => x.tsa === "sigstore" && x.lastError !== null),
      10_000,
    );
    expect(first.find((r) => r.tsa === "digicert")?.status).toBe("stamped");
    expect(first.find((r) => r.tsa === "sigstore")).toMatchObject({
      status: "pending",
      lastError: "tsa-timeout",
    });

    const replaced = await until(
      () => rows(hash),
      (r) => r.some((x) => x.tsa === "sectigo" && x.status === "stamped"),
      40_000,
    );
    expect(replaced.find((r) => r.tsa === "sigstore")).toMatchObject({ status: "failed" });
    const sectigo = replaced.find((r) => r.tsa === "sectigo");
    expect(sectigo).toMatchObject({ role: "fallback", status: "stamped" });
    expect((await verifyTimestamp(sectigo?.token as Buffer, hash)).tsa).toBe("sectigo");
    expect((await stampsFor(testDb, hash)).map((s) => [s.tsa, s.role])).toEqual([
      ["digicert", "primary"],
      ["sectigo", "fallback"],
    ]);
  });

  test("two workers on one database store each token once", async () => {
    const a = worker({ sweepIntervalMs: 1_000 });
    const b = worker({ sweepIntervalMs: 1_000 });
    const hashes = Array.from({ length: 20 }, () => randomBytes(32));
    for (const [i, hash] of hashes.entries()) {
      enqueueStamp({ db: testDb, log, stamps: i % 2 ? a : b }, hash, "leaf");
      (i % 2 ? b : a).wake();
    }

    const all = async () => (await Promise.all(hashes.map(rows))).flat();
    const done = await until(
      all,
      (r) => r.filter((x) => x.status === "stamped").length >= 40,
      20_000,
    );
    expect(done.filter((r) => r.status === "stamped")).toHaveLength(40);
    expect(done).toHaveLength(40);
    expect(errors).toEqual([]);
  });

  test("rows left pending by a stopped worker are finished by the next one", async () => {
    const hashes = Array.from({ length: 3 }, () => randomBytes(32));
    for (const hash of hashes) enqueueStamp({ db: testDb, log }, hash, "channel3");
    const all = async () => (await Promise.all(hashes.map(rows))).flat();
    const pending = await until(all, (r) => r.length === 6, 2_000);
    expect(pending.map((r) => r.status)).toEqual(Array(6).fill("pending"));

    worker();
    const done = await until(all, (r) => r.every((x) => x.status === "stamped"), 5_000);
    expect(done.map((r) => r.status)).toEqual(Array(6).fill("stamped"));
    expect(done.every((r) => r.kind === "channel3")).toBe(true);
  });
});
