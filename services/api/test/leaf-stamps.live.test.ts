import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Countersign } from "@keelson/core/eip712";
import { eq, inArray, mandates, operators, sql, teeSigners, timestamps, user } from "@keelson/db";
import {
  LOG_ORIGINS,
  leafBytes,
  leafFromCountersign,
  leafHash,
  paypalRefCommit,
} from "@keelson/log";
import { TSA_INTERMEDIATES, TSA_ROOTS, type TsaId, verifyTimestamp } from "@keelson/timestamp";
import { pino } from "pino";
import { ulid } from "ulid";
import { bytesToHex, type Hex, hexToBytes } from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { appendLeaf } from "../src/log/append.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { type StampWorker, startStampWorker } from "../src/timestamps/worker.ts";
import { EvidenceUploader } from "./evidence.ts";
import { type LocalLog, startLocalLog } from "./log-live.ts";
import { testDb, testDbUrl, testKv } from "./setup.ts";
import {
  type Agent,
  asUser,
  carts,
  headerPrincipal,
  holdOnSandboxAuthorization,
  live,
  liveEnv,
  registerMandate,
  repeating,
  request,
  SoftwarePasskey,
  seedUser,
  signedMandate,
} from "./tee-live.ts";

const UNREACHABLE = "http://10.255.255.1/";
const sandbox = LOG_ORIGINS[421614] as string;

interface Purchase {
  id: string;
  leaf: Uint8Array;
  countersign: Record<string, string>;
}

const percentile = (xs: number[], q: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)] ?? 0;

/** The tlog-tiles path of entry bundle `n`: `000`, `x001/234`, ... */
const bundlePath = (n: bigint) => {
  const s = n.toString().padStart(3, "0");
  const groups = s.padStart(Math.ceil(s.length / 3) * 3, "0").match(/.../g) as string[];
  return groups.map((g, i) => (i < groups.length - 1 ? `x${g}` : g)).join("/");
};

/** Reads entry `index` from the public, partial or full, entry bundle that holds it. */
async function publicEntry(base: string, index: bigint): Promise<Uint8Array> {
  const path = sandbox.slice(sandbox.indexOf("/") + 1);
  const checkpoint = await (await fetch(`${base}/${path}/checkpoint`)).text();
  const size = BigInt(checkpoint.split("\n")[1] as string);
  const n = index / 256n;
  const width = size - n * 256n < 256n ? `.p/${size - n * 256n}` : "";
  const res = await fetch(`${base}/${path}/tile/entries/${bundlePath(n)}${width}`);
  expect(res.status).toBe(200);
  const bundle = new Uint8Array(await res.arrayBuffer());
  let at = 0;
  for (let i = 0n; ; i++) {
    const len = ((bundle[at] as number) << 8) | (bundle[at + 1] as number);
    if (n * 256n + i === index) return bundle.subarray(at + 2, at + 2 + len);
    at += 2 + len;
  }
}

function openssl(tsa: TsaId, token: Uint8Array, digest: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "keelson-ts-"));
  writeFileSync(join(dir, "token.der"), token);
  writeFileSync(join(dir, "root.pem"), `${TSA_ROOTS[tsa]}\n`);
  const args = ["ts", "-verify", "-token_in", "-in", join(dir, "token.der")];
  args.push("-digest", bytesToHex(digest).slice(2), "-CAfile", join(dir, "root.pem"));
  const intermediate = TSA_INTERMEDIATES[tsa];
  if (intermediate) {
    writeFileSync(join(dir, "untrusted.pem"), `${intermediate}\n`);
    args.push("-untrusted", join(dir, "untrusted.pem"));
  }
  return execFileSync("openssl", args, { encoding: "utf8" });
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!live)(
  "every appended leaf is timestamped (live legs and TSAs)",
  { timeout: 900_000 },
  () => {
    const tee = createTee(liveEnv(), { a: 10_000, b: 10_000 });
    const log = pino({ level: "silent" });
    const app = createApp({
      db: testDb,
      kv: testKv,
      log,
      appOrigin: "https://app.keelson.finance",
      authenticate: headerPrincipal,
      tee,
      requestTimeoutMs: 60_000,
    });
    const post = (path: string, body: unknown, headers: Record<string, string>) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
        body: JSON.stringify(body),
      });
    const asAgentNo = (k: number) => ({
      "x-test-principal": JSON.stringify({
        kind: "client",
        subject: `stamp-agent-${k}`,
        scopes: ["countersign:write", "evidence:write"],
      }),
    });
    // $0.30 carts keep the mandate's budget from running out.
    const cheap = structuredClone(carts.demo);
    for (const line of cheap.cart.lines) line.unit_minor = 30;
    cheap.unit.amount.value = "0.30";
    cheap.unit.amount.breakdown.item_total.value = "0.30";
    const salt = randomBytes(32);
    const evidence = new EvidenceUploader();
    let tlog: LocalLog;
    let agent: Agent;
    let mandateId: string;
    let made = 0;

    const measurement = async (address: Hex | null) => {
      if (address === null) return null;
      const [row] = await testDb
        .select({ m: teeSigners.measurement })
        .from(teeSigners)
        .where(eq(teeSigners.address, Buffer.from(hexToBytes(address))));
      return row?.m ?? null;
    };

    /** Countersigns a purchase through the API and builds its leaf. */
    const purchase = async (): Promise<Purchase> => {
      const i = made++;
      const r = await request(agent, cheap, ulid());
      const principal = asAgentNo(Math.floor(i / 50));
      if (i % 50 === 0) {
        // Only the client the operator linked buys under its mandates.
        await testDb
          .update(operators)
          .set({ clientId: `stamp-agent-${i / 50}` })
          .where(
            sql`${operators.agentId} = (select operator_agent_id from mandates where id = ${mandateId})`,
          );
      }
      const res = await post(
        "/v1/countersign",
        {
          authorizationId: r.authorization_id,
          closedMandate: r.closed_mandate,
          cart: r.cart,
          unit: r.unit,
          evidenceRoot: await evidence.upload(app, mandateId, r.cart, principal),
          ...(await repeating(testDb, mandateId, r.cart, r.request_id)),
        },
        principal,
      );
      const out = (await res.json()) as {
        purchaseId: string;
        mode: "2of2" | "degraded";
        countersign: Record<string, string>;
        digest: Hex;
        signatures: { tdx: Hex; nitro: Hex | null };
        signers: { tdx: Hex; nitro: Hex | null };
      };
      expect(res.status, JSON.stringify(out)).toBe(200);
      const c = out.countersign;
      const message: Countersign = {
        requestId: c.requestId as Hex,
        mandateHash: c.mandateHash as Hex,
        mandateCommitment: c.mandateCommitment as Hex,
        cartHash: c.cartHash as Hex,
        agentId: BigInt(c.agentId as string),
        merchantId: c.merchantId as Hex,
        amount: BigInt(c.amount as string),
        currency: Number(c.currency),
        category: Number(c.category),
        evidenceRoot: c.evidenceRoot as Hex,
        evalHash: c.evalHash as Hex,
        policySetHash: c.policySetHash as Hex,
        decision: Number(c.decision),
        failedFieldsMask: Number(c.failedFieldsMask),
        issuedAt: Number(c.issuedAt),
        expiresAt: Number(c.expiresAt),
      };
      const leaf = leafBytes(
        leafFromCountersign(
          message,
          out.digest,
          out.mode,
          out.signatures,
          {
            tdx: (await measurement(out.signers.tdx)) as string,
            nitro: await measurement(out.signers.nitro),
          },
          paypalRefCommit(salt, `ORDER${i}`, `AUTH${i}`),
        ),
      );
      return { id: out.purchaseId, leaf, countersign: c };
    };

    const appendAll = async (purchases: Purchase[], stamps: StampWorker) => {
      const deps = {
        db: testDb,
        log,
        stamps,
        tlog: { url: tlog.url, token: tlog.token, vkeys: tlog.vkeys },
      };
      const times: number[] = [];
      const hashes: Uint8Array[] = [];
      for (const p of purchases) {
        const started = performance.now();
        const result = await appendLeaf(deps, p.id, p.leaf, p.countersign);
        times.push(performance.now() - started);
        hashes.push(result.leafHash);
      }
      return { times, hashes };
    };

    const stampedRows = (hashes: Uint8Array[]) =>
      testDb
        .select()
        .from(timestamps)
        .where(
          inArray(
            timestamps.hash,
            hashes.map((h) => Buffer.from(h)),
          ),
        );

    beforeAll(async () => {
      tlog = await startLocalLog(testDbUrl);
      const passkey = await SoftwarePasskey.create();
      await refreshLeg(testDb, "a", tee);
      await refreshLeg(testDb, "b", tee);
      const first = await signedMandate(passkey);
      await seedUser(testDb, passkey, first.sub);
      const stored = await post("/v1/mandates", first.body, asUser(first.sub));
      expect(stored.status).toBe(201);
      mandateId = ((await stored.json()) as { id: string }).id;
      await holdOnSandboxAuthorization(testDb, mandateId);
      agent = await registerMandate(tee.client.a, passkey);
      await testDb
        .insert(user)
        .values({ id: agent.sub, name: "Tester", email: `${agent.sub}@example.test` });
      await testDb
        .update(mandates)
        .set({
          userId: agent.sub,
          openMandate: agent.issued.open_mandate,
          mandateHash: Buffer.from(hexToBytes(agent.issued.mandate_hash)),
        })
        .where(eq(mandates.id, mandateId));
    }, 300_000);
    afterAll(async () => {
      await tlog?.stop();
      await evidence.close();
    });

    test("the public entry hashes to the leaf hash both tokens stamp", async () => {
      const stamps = startStampWorker({ db: testDb, kv: testKv, log });
      try {
        const p = await purchase();
        const deps = {
          db: testDb,
          log,
          stamps,
          tlog: { url: tlog.url, token: tlog.token, vkeys: tlog.vkeys },
        };
        const result = await appendLeaf(deps, p.id, p.leaf, p.countersign);
        const entry = await publicEntry(tlog.publicUrl, result.index);
        const fromTile = leafHash(entry);
        expect(bytesToHex(fromTile)).toBe(bytesToHex(result.leafHash));

        const rows = await until(
          () => stampedRows([fromTile]),
          (r) => r.filter((x) => x.status === "stamped").length === 2,
          5_000,
        );
        expect(rows.map((r) => r.tsa).sort()).toEqual(["digicert", "sigstore"]);
        for (const row of rows) {
          const token = row.token as Buffer;
          expect((await verifyTimestamp(token, fromTile)).tsa).toBe(row.tsa);
          expect(openssl(row.tsa as TsaId, token, fromTile)).toContain("Verification: OK");
        }

        const served = await app.request(`/v1/timestamps/${bytesToHex(fromTile).slice(2)}`);
        expect(served.status).toBe(200);
        expect(((await served.json()) as { stamps: unknown[] }).stamps).toHaveLength(2);
      } finally {
        await stamps.stop();
      }
    });

    test("appends take as long with the TSAs down, and every leaf is stamped once they are back", async () => {
      // 30 a side: a mandate holds at most 64 evidence bundles, one per purchase.
      const batch = async () => {
        const out: Purchase[] = [];
        for (let i = 0; i < 30; i++) out.push(await purchase());
        return out;
      };
      const reachable = await batch();
      const unreachable = await batch();

      const real = startStampWorker({ db: testDb, kv: testKv, log });
      const up = await appendAll(reachable, real);
      await real.stop();
      const down = startStampWorker(
        { db: testDb, kv: testKv, log },
        { urls: { digicert: UNREACHABLE, sigstore: UNREACHABLE }, sweepIntervalMs: 3_600_000 },
      );
      const without = await appendAll(unreachable, down);
      await down.stop();

      const p95Up = percentile(up.times, 0.95);
      const p95Down = percentile(without.times, 0.95);
      console.info(`append p95: TSAs up ${p95Up.toFixed(1)} ms, down ${p95Down.toFixed(1)} ms`);
      expect(Math.abs(p95Up - p95Down)).toBeLessThanOrEqual(5);

      const pending = await stampedRows(without.hashes);
      expect(pending.filter((r) => r.status === "stamped")).toHaveLength(0);

      const restored = startStampWorker(
        { db: testDb, kv: testKv, log },
        { sweepIntervalMs: 1_000 },
      );
      try {
        const all = [...up.hashes, ...without.hashes];
        const rows = await until(
          () => stampedRows(all),
          (r) => r.filter((x) => x.status === "stamped").length === 120,
          90_000,
        );
        expect(rows.filter((r) => r.status === "stamped")).toHaveLength(120);
      } finally {
        await restored.stop();
      }
    });
  },
);
