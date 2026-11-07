import { cartHash } from "@keelson/core";
import type { Countersign } from "@keelson/core/eip712";
import { and, eq, isNull, mandates, purchases, teeSigners, user } from "@keelson/db";
import {
  LEAF_PREFIX,
  LOG_ORIGINS,
  LogError,
  leafBytes,
  leafFromCountersign,
  leafHash,
  paypalRefCommit,
  verifyProof,
} from "@keelson/log";
import { closeMandate } from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import { bytesToHex, type Hex, hexToBytes } from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { appendLeaf } from "../src/log/append.ts";
import { LegClient } from "../src/tee/client.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { EvidenceUploader } from "./evidence.ts";
import { type LocalLog, startLocalLog } from "./log-live.ts";
import { testDb, testDbUrl, testKv } from "./setup.ts";
import {
  asAgent,
  asUser,
  carts,
  headerPrincipal,
  live,
  liveEnv,
  registerMandate,
  SoftwarePasskey,
  seedUser,
  signedMandate,
} from "./tee-live.ts";

interface Countersigned {
  purchaseId: string;
  mode: "2of2" | "degraded";
  decision: "allow" | "deny";
  countersign: Record<string, string>;
  digest: Hex;
  signatures: { tdx: Hex; nitro: Hex | null };
  signers: { tdx: Hex; nitro: Hex | null };
}

const message = (c: Record<string, string>): Countersign => ({
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
});

/** The tlog-tiles path of entry bundle `n`: `000`, `x001/234`, ... */
const bundlePath = (n: bigint) => {
  const s = n.toString().padStart(3, "0");
  const groups = s.padStart(Math.ceil(s.length / 3) * 3, "0").match(/.../g) as string[];
  return groups.map((g, i) => (i < groups.length - 1 ? `x${g}` : g)).join("/");
};

/** Reads entry `index` from the public entry bundle a tree of `size` has. */
async function publicEntry(base: string, origin: string, index: bigint, size: bigint) {
  const n = index / 256n;
  const width = size - n * 256n < 256n ? `.p/${size - n * 256n}` : "";
  const path = origin.slice(origin.indexOf("/") + 1);
  const res = await fetch(`${base}/${path}/tile/entries/${bundlePath(n)}${width}`);
  expect(res.status).toBe(200);
  const bundle = new Uint8Array(await res.arrayBuffer());
  let at = 0;
  for (let i = 0n; ; i++) {
    const len = ((bundle[at] as number) << 8) | (bundle[at + 1] as number);
    const entry = bundle.subarray(at + 2, at + 2 + len);
    if (n * 256n + i === index) return entry;
    at += 2 + len;
  }
}

describe.skipIf(!live)(
  "appending countersigned leaves to the log (live legs)",
  { timeout: 300_000 },
  () => {
    const tee = createTee(liveEnv(), { a: 10_000, b: 10_000 });
    const log = pino({ level: "silent" });
    let tlog: LocalLog;
    const sandbox = LOG_ORIGINS[421614] as string;
    const appWith = (client = tee.client) =>
      createApp({
        db: testDb,
        kv: testKv,
        log,
        appOrigin: "https://app.keelson.finance",
        authenticate: headerPrincipal,
        tee: { ...tee, client },
        requestTimeoutMs: 60_000,
      });
    let passkey: SoftwarePasskey;
    let mandateId: string;
    const salt = new Uint8Array(32).fill(7);
    const evidence = new EvidenceUploader();

    const issue = async () => {
      const agent = await registerMandate(tee.client.a, passkey);
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
      return { openMandate: agent.issued.open_mandate, agentKey: agent.key };
    };

    const countersign = async (
      cart: (typeof carts)[keyof typeof carts],
      client = tee.client,
    ): Promise<Countersigned & { header: string | null }> => {
      const m = await issue();
      const requestId = ulid();
      const hash = bytesToHex(cartHash(cart.cart)).slice(2);
      const res = await appWith(client).request("/v1/countersign", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": ulid(), ...asAgent },
        body: JSON.stringify({
          authorizationId: process.env.PAYPAL_AUTHORIZATION_CREATED as string,
          closedMandate: await closeMandate(
            m.openMandate,
            { requestId, cartHash: `sha256:${hash}` },
            m.agentKey,
          ),
          cart: cart.cart,
          unit: cart.unit,
          evidenceRoot: await evidence.upload(appWith(), mandateId, cart.cart, asAgent),
        }),
      });
      const out = (await res.json()) as Countersigned;
      expect(res.status, JSON.stringify(out)).toBe(200);
      return { ...out, header: res.headers.get("keelson-countersign-mode") };
    };

    const measurementOf = async (address: Hex | null) => {
      if (address === null) return null;
      const [row] = await testDb
        .select({ measurement: teeSigners.measurement })
        .from(teeSigners)
        .where(
          and(
            eq(teeSigners.address, Buffer.from(hexToBytes(address))),
            isNull(teeSigners.revokedAt),
          ),
        );
      return row?.measurement ?? null;
    };

    const leafOf = async (out: Countersigned) =>
      leafBytes(
        leafFromCountersign(
          message(out.countersign),
          out.digest,
          out.mode,
          out.signatures,
          {
            tdx: (await measurementOf(out.signers.tdx)) as string,
            nitro: await measurementOf(out.signers.nitro),
          },
          paypalRefCommit(salt, "5O190127TN364715T", "0VF52814937998046"),
        ),
      );

    /** Appends, then checks the proof, the stored index and the public entry. */
    const appended = async (out: Countersigned) => {
      const leaf = await leafOf(out);
      const deps = { db: testDb, tlog: { url: tlog.url, token: tlog.token, vkeys: tlog.vkeys } };
      const result = await appendLeaf(deps, out.purchaseId, leaf, out.countersign);
      expect(bytesToHex(result.leafHash)).toBe(bytesToHex(leafHash(leaf)));
      const { index, checkpoint } = verifyProof(
        result.proof,
        result.leafHash,
        tlog.vkeys[sandbox] as [string, string],
      );
      expect(index).toBe(result.index);
      const [row] = await testDb.select().from(purchases).where(eq(purchases.id, out.purchaseId));
      expect(row?.logIndex).toBe(result.index);
      const entry = await publicEntry(tlog.publicUrl, sandbox, index, checkpoint.size);
      expect(bytesToHex(leafHash(entry))).toBe(bytesToHex(result.leafHash));

      const again = await appendLeaf(deps, out.purchaseId, leaf, out.countersign);
      expect(again.index).toBe(result.index);
      return { entry: new TextDecoder().decode(entry), result };
    };

    beforeAll(async () => {
      tlog = await startLocalLog(testDbUrl);
      passkey = await SoftwarePasskey.create();
      await refreshLeg(testDb, "a", tee);
      await refreshLeg(testDb, "b", tee);
      const signed = await signedMandate(passkey);
      await seedUser(testDb, passkey, signed.sub);
      const created = await appWith().request("/v1/mandates", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": ulid(),
          ...asUser(signed.sub),
        },
        body: JSON.stringify(signed.body),
      });
      const json = (await created.json()) as { id: string };
      expect(created.status, JSON.stringify(json)).toBe(201);
      mandateId = json.id;
    }, 300_000);
    afterAll(async () => {
      await tlog?.stop();
      await evidence.close();
    });

    test("the demo allow is appended and its proof verifies against both log keys", async () => {
      const out = await countersign(carts.demo);
      expect(out.decision).toBe("allow");
      expect(out.mode).toBe("2of2");
      const { entry } = await appended(out);
      expect(entry.startsWith(LEAF_PREFIX)).toBe(true);
      expect(entry).toContain('"mode":"2of2"');
    });

    test("the $340 deny is appended too", async () => {
      const out = await countersign(carts.bundle);
      expect(out.decision).toBe("deny");
      await appended(out);
    });

    test("with leg b down the degraded countersign is appended with one signature, then 2-of-2 resumes", async () => {
      const down = new LegClient(
        "b",
        "http://127.0.0.1:9",
        process.env.KEELSON_TEE_TOKEN as string,
        500,
      );
      const out = await countersign(carts.demo, { a: tee.client.a, b: down });
      expect(out.header).toBe("degraded");
      const [row] = await testDb.select().from(purchases).where(eq(purchases.id, out.purchaseId));
      expect(row?.countersignMode).toBe("degraded");
      const { entry } = await appended(out);
      const body = JSON.parse(entry.slice(LEAF_PREFIX.length)) as {
        mode: string;
        tee_sigs: string[];
      };
      expect(body.mode).toBe("degraded");
      expect(body.tee_sigs).toHaveLength(1);

      const next = await countersign(carts.demo);
      expect(next.mode).toBe("2of2");
      await appended(next);
    });

    test("a leaf whose mode is not the purchase's is refused before the log sees it", async () => {
      const out = await countersign(carts.demo);
      const leaf = await leafOf(out);
      await testDb
        .update(purchases)
        .set({ countersignMode: "degraded" })
        .where(eq(purchases.id, out.purchaseId));
      const err = await appendLeaf(
        { db: testDb, tlog: { url: "http://127.0.0.1:9", token: tlog.token } },
        out.purchaseId,
        leaf,
        out.countersign,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LogError);
      expect((err as LogError).kind).toBe("rejected");
      expect((err as LogError).code).toBe("countersign.mode");
    });

    test("an answer that does not verify against the origin's keys is not recorded", async () => {
      const out = await countersign(carts.demo);
      const leaf = await leafOf(out);
      const other = tlog.vkeys[LOG_ORIGINS[42161] as string] as [string, string];
      const err = await appendLeaf(
        { db: testDb, tlog: { url: tlog.url, token: tlog.token, vkeys: { [sandbox]: other } } },
        out.purchaseId,
        leaf,
        out.countersign,
      ).catch((e: unknown) => e);
      expect((err as LogError).kind).toBe("invalid");
      const [row] = await testDb.select().from(purchases).where(eq(purchases.id, out.purchaseId));
      expect(row?.logIndex).toBeNull();
    });

    test("the log is up in the status", async () => {
      const app = createApp({
        db: testDb,
        kv: testKv,
        log,
        tlog: { url: tlog.url, token: tlog.token },
      });
      const res = await app.request("/status");
      const body = (await res.json()) as {
        status: string;
        dependencies: {
          log: {
            status: string;
            origins: { origin: string; size: number; checkpointAgeMs: number }[];
          };
        };
      };
      expect(body.dependencies.log.status).toBe("up");
      const sandboxState = body.dependencies.log.origins.find((o) => o.origin === sandbox);
      expect(sandboxState?.size).toBeGreaterThanOrEqual(5);
      expect(sandboxState?.checkpointAgeMs).toBeLessThan(120_000);
    });
  },
);
