import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { pino } from "pino";
import { afterAll, describe, expect, test } from "vitest";
import {
  remote,
  revokeMandate,
  signIn,
  type UserSession,
  waitC3Published,
  watchPurchase,
} from "../bench/public-client.ts";
import { waterfall } from "../bench/waterfall.ts";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { authenticate } from "../src/middleware/auth.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";
import { SoftwarePasskey, seedUser } from "./tee-live.ts";

const bench = new URL("../bench/", import.meta.url);

describe("the benches", () => {
  // The end-to-end probes of the deployed service; the other benches time components in-process.
  test("of the money path and of live checkout reach Keelson only through its public API", () => {
    const files = ["money-path.bench.ts", "live-checkout.bench.ts", "public-client.ts"];
    expect(readdirSync(bench)).toEqual(expect.arrayContaining(files));
    // Static, side-effect and dynamic imports.
    const specifier = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
    const imports = files.flatMap((f) =>
      [...readFileSync(new URL(f, bench), "utf8").matchAll(specifier)].map((m) => `${f} → ${m[1]}`),
    );
    const direct = imports.filter((i) =>
      /→ (@keelson\/db|\.\.\/src\/(app|server|kv|env|alibi\/issue)\.ts|\.\.\/test\/render-live\.ts)$/.test(
        i,
      ),
    );
    expect(direct).toEqual([]);
  });
});

describe("the waterfall", () => {
  test("groups each purchase's Server-Timing by step, host, work and Postgres time", () => {
    const w = waterfall([
      { "step.LOGGED": 800, "db.LOGGED": 3, "out.log.keelson.finance": 120, "int.leg.a": 40 },
      { "step.LOGGED": 1_000, "db.LOGGED": 5, "out.log.keelson.finance": 140 },
    ]);
    expect(w.steps).toEqual({ "purchase.LOGGED": { p50: 800, p95: 1_000, max: 1_000, count: 2 } });
    expect(w.db).toEqual({ "purchase.LOGGED": { p50: 3, p95: 5, max: 5, count: 2 } });
    expect(w.outbound["log.keelson.finance"]?.count).toBe(2);
    expect(w.internal).toEqual({ "leg.a": { p50: 40, p95: 40, max: 40, count: 1 } });
  });
});

describe("the public client", () => {
  const secret = randomBytes(32).toString("base64url");
  let app!: OpenAPIHono;
  const server = serve({ fetch: (req) => app.fetch(req), port: 0, hostname: "localhost" });
  const listening = new Promise<void>((resolve) => server.once("listening", () => resolve()));
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  test("signs in with a passkey over HTTP and acts as that user", async () => {
    await listening;
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const auth = createAuth(testDb, { ...testAuthEnv(base, secret), PASSKEY_RP_ID: "localhost" });
    app = createApp({
      db: testDb,
      kv: testKv,
      log: pino({ level: "silent" }),
      auth,
      appOrigin: base,
      authenticate: authenticate(auth, base),
    });
    const passkey = await SoftwarePasskey.create({ id: "localhost", origin: base });
    const sub = `kls_usr_${randomBytes(8).toString("hex")}`;
    await seedUser(testDb, passkey, sub);

    const user = await signIn(base, passkey, base);
    expect(user.sub).toBe(sub);
    const passkeys = await user.api.request("/v1/passkeys");
    expect(passkeys.status).toBe(200);

    const stranger = await remote(base).request("/v1/passkeys");
    expect(stranger.status).toBe(401);
  });
});

/** A stand-in Keelson API on a real socket, answering with `handle`. */
async function standIn(handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

const asUserSession = (base: string): UserSession => {
  const api = remote(base);
  return {
    sub: "kls_usr_bench",
    api,
    async post(path, body) {
      const res = await api.request(path, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, out: (await res.json()) as Record<string, unknown> };
    },
  };
};

describe("the bench's waits", () => {
  test("a purchase ends when its state says so, even if its event never comes", async () => {
    let reads = 0;
    const api = await standIn((req, res) => {
      if (req.url?.startsWith("/v1/events")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": connected\n\n");
        return;
      }
      reads++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ state: reads < 3 ? "COVERED" : "CAPTURED" }));
    });
    const watch = watchPurchase(
      remote(api.base),
      "client:x",
      "01M76PDV1TFAEC0TBB1HS687VA",
      20_000,
      50,
    );
    await watch.ready;
    const started = Date.now();
    expect(await watch.ended).toBe("CAPTURED");
    expect(Date.now() - started).toBeLessThan(5_000);
    await api.close();
  });

  test("a revoke of a mandate that already ended counts as done, other refusals do not", async () => {
    const problem = (type: string) => ({ type: `https://api.keelson.finance/problems/${type}` });
    const api = await standIn((req, res) => {
      res.statusCode = 409;
      res.setHeader("content-type", "application/problem+json");
      res.end(
        JSON.stringify(problem(req.url?.includes("ENDED") ? "mandate-ended" : "hold-not-pending")),
      );
    });
    const user = asUserSession(api.base);
    await expect(revokeMandate(user, "ENDED")).resolves.toBeUndefined();
    await expect(revokeMandate(user, "OTHER")).rejects.toThrow(/409/);
    await api.close();
  });

  test("waits for a mandate's C3 to be published and says how long it took", async () => {
    let reads = 0;
    const api = await standIn((_req, res) => {
      reads++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ c3Published: reads >= 3 }));
    });
    const ms = await waitC3Published(asUserSession(api.base), "M1", Date.now(), 20_000, 50);
    expect(reads).toBe(3);
    expect(ms).toBeGreaterThanOrEqual(0);
    await api.close();
  });
});
