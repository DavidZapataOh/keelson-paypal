import { randomBytes } from "node:crypto";
import { mandates, operators, user } from "@keelson/db";
import {
  buildManifest,
  type Disclosure,
  type SealedItem,
  verifyDisclosure,
} from "@keelson/evidence";
import type { Capture } from "@keelson/evidence/capture";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { ageKeys, capturePage, uploadBody } from "./evidence.ts";
import { testDb, testKv } from "./setup.ts";
import { headerPrincipal } from "./tee-live.ts";

const as = (...scopes: string[]) => ({
  "x-test-principal": JSON.stringify({ kind: "client", subject: "evidence-test", scopes }),
});
const writer = as("evidence:write");
const arbiter = as("evidence:disclose");

const buyerEmail = process.env.PAYPAL_SANDBOX_BUYER_EMAIL;

async function mandate(): Promise<string> {
  const userId = `user-${ulid()}`;
  await testDb.insert(user).values({ id: userId, name: "Tester", email: `${userId}@example.test` });
  const [operator] = await testDb
    .insert(operators)
    .values({
      agentId: BigInt(`0x${randomBytes(12).toString("hex")}`),
      chainId: 421614,
      name: "op",
      cnfJwk: {},
    })
    .returning();
  const id = ulid();
  await testDb.insert(mandates).values({
    id,
    userId,
    operatorAgentId: (operator as { agentId: bigint }).agentId,
    currency: "USD",
    maxMinor: 10_000n,
    remainingMinor: 10_000n,
    merchantIds: ["northfield-outfitters"],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return id;
}

describe("evidence routes", { timeout: 60_000 }, () => {
  let keys: Awaited<ReturnType<typeof ageKeys>>;
  let app: ReturnType<typeof createApp>;
  let mandateId: string;
  let capture: Capture;

  const post = (body: unknown, headers = writer) =>
    app.request("/v1/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    keys = await ageKeys();
    app = createApp({
      db: testDb,
      kv: testKv,
      log: pino({ level: "silent" }),
      authenticate: headerPrincipal,
      evidenceIdentity: keys.identity,
    });
    mandateId = await mandate();
    capture = await capturePage("product.html", keys);
  });

  test("a real capture is stored under its root and its manifest is public, without salts", async () => {
    const res = await post(uploadBody(mandateId, capture));
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await res.json()).toEqual({ evidenceRoot: capture.manifest.root });

    const manifest = await app.request(`/v1/evidence/${capture.manifest.root}`);
    expect(manifest.status).toBe(200);
    const text = await manifest.text();
    expect(JSON.parse(text)).toEqual(capture.manifest);
    expect(text).not.toContain("salt");
  });

  test("an arbiter gets one item with a disclosure that verifies against the root", async () => {
    const res = await app.request(`/v1/evidence/${capture.manifest.root}/items/3`, {
      headers: arbiter,
    });
    expect(res.status).toBe(200);
    const { disclosure, bytes } = (await res.json()) as { disclosure: Disclosure; bytes: string };
    expect(disclosure.type).toBe("dom.snapshot");
    const raw = Uint8Array.from(Buffer.from(bytes, "base64"));
    expect(verifyDisclosure(capture.manifest.root, disclosure, raw)).toBe(true);
    expect(raw).toEqual(capture.items[3]?.bytes);

    const anonymous = await app.request(`/v1/evidence/${capture.manifest.root}/items/3`);
    expect(anonymous.status).toBe(401);
    const missing = await app.request(`/v1/evidence/${capture.manifest.root}/items/17`, {
      headers: arbiter,
    });
    expect(missing.status).toBe(404);
  });

  test("a manifest the items do not build is refused", async () => {
    const other = await capturePage("product.html", keys);
    const body = uploadBody(mandateId, other);
    body.manifest = { ...body.manifest, root: capture.manifest.root };
    const res = await post(body);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { type: string }).type).toMatch(/evidence-root-mismatch$/);
  });

  test("a public item that still holds an email address is refused", async () => {
    const items: SealedItem[] = capture.items.map((i) =>
      i.type === "llm.observation"
        ? { ...i, bytes: new TextEncoder().encode("contact: sales@northfield-outfitters.com") }
        : i,
    );
    const res = await post(uploadBody(mandateId, { manifest: buildManifest(items), items }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { type: string }).type).toMatch(/evidence-pii$/);
  });

  test("a bundle over 1 MiB is accepted", async () => {
    const big = new TextEncoder().encode("Trail Runner 2 ".repeat(100_000));
    const items: SealedItem[] = capture.items.map((i) =>
      i.type === "llm.observation" ? { ...i, bytes: big } : i,
    );
    const res = await post(uploadBody(mandateId, { manifest: buildManifest(items), items }));
    expect(res.status).toBe(201);
  });

  test.skipIf(!buyerEmail)("an original opens only for an arbiter that may decrypt", async () => {
    const checkout = await capturePage("checkout.html", {
      recipient: keys.recipient,
      pii: { email: buyerEmail as string },
      fill: { "#email": buyerEmail as string },
    });
    expect((await post(uploadBody(mandateId, checkout))).status).toBe(201);
    const index = checkout.items.findIndex((i) => i.type === "dom.snapshot.original");
    expect(index).toBeGreaterThan(0);
    const url = `/v1/evidence/${checkout.manifest.root}/items/${index}`;

    const sealed = (await (await app.request(url, { headers: arbiter })).json()) as {
      bytes: string;
    };
    expect(Buffer.from(sealed.bytes, "base64").toString("latin1")).not.toContain(buyerEmail);
    expect((await app.request(`${url}?decrypt=1`, { headers: arbiter })).status).toBe(403);

    const opened = await app.request(`${url}?decrypt=1`, {
      headers: as("evidence:disclose", "evidence:decrypt"),
    });
    expect(opened.status).toBe(200);
    const { bytes } = (await opened.json()) as { bytes: string };
    expect(Buffer.from(bytes, "base64").toString("utf8")).toContain(buyerEmail);
  });
});
