import { createHash, randomBytes } from "node:crypto";
import { eq, evidenceAccess, evidenceBundles, mandates, operators, user } from "@keelson/db";
import {
  buildManifest,
  type Disclosure,
  type SealedItem,
  verifyDisclosure,
  verifyManifest,
} from "@keelson/evidence";
import type { Capture } from "@keelson/evidence/capture";
import { pino } from "pino";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { EVIDENCE_BUNDLES_PER_MANDATE } from "../src/routes/evidence.ts";
import { ageKeys, StoreCapture, uploadBody } from "./evidence.ts";
import { testDb, testKv } from "./setup.ts";
import { headerPrincipal } from "./tee-live.ts";

const as = (...scopes: string[]) => ({
  "x-test-principal": JSON.stringify({ kind: "client", subject: "evidence-test", scopes }),
});
const writer = as("evidence:write");
const arbiter = as("evidence:disclose");

const buyerEmail = process.env.PAYPAL_SANDBOX_BUYER_EMAIL;

async function mandate(state: "ACTIVE" | "DRAFT" = "ACTIVE"): Promise<string> {
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
    state,
    currency: "USD",
    maxMinor: 10_000n,
    remainingMinor: 10_000n,
    merchantIds: ["northfield-outfitters"],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return id;
}

/** The same items with fresh salts: another bundle with its own root. */
function resalted(capture: Pick<Capture, "items">): {
  manifest: ReturnType<typeof buildManifest>;
  items: SealedItem[];
} {
  const items = capture.items.map((i) => ({
    ...i,
    salt: crypto.getRandomValues(new Uint8Array(32)),
  }));
  return { manifest: buildManifest(items), items };
}

const problemType = async (res: Response) => ((await res.json()) as { type: string }).type;

describe("evidence routes", { timeout: 120_000 }, () => {
  const store = new StoreCapture();
  let keys: Awaited<ReturnType<typeof ageKeys>>;
  let app: ReturnType<typeof createApp>;
  let mandateId: string;
  let capture: Capture;

  const post = (body: unknown, headers: Record<string, string> = writer, target = app) =>
    target.request("/v1/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
      body: JSON.stringify(body),
    });
  const appWith = (evidenceIdentity?: string) =>
    createApp({
      db: testDb,
      kv: testKv,
      log: pino({ level: "silent" }),
      authenticate: headerPrincipal,
      ...(evidenceIdentity ? { evidenceIdentity } : {}),
    });

  beforeAll(async () => {
    keys = await ageKeys();
    app = appWith(keys.identity);
    mandateId = await mandate();
    capture = await store.capture("product.html", keys);
  });
  afterAll(async () => {
    await store.close();
  });

  test("a real capture is stored under its root, with the client that stored it", async () => {
    const res = await post(uploadBody(mandateId, capture));
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await res.json()).toEqual({ evidenceRoot: capture.manifest.root });
    const [row] = await testDb
      .select({ uploadedBy: evidenceBundles.uploadedBy })
      .from(evidenceBundles)
      .where(eq(evidenceBundles.root, Buffer.from(capture.manifest.root.slice(2), "hex")));
    expect(row?.uploadedBy).toBe("evidence-test");
  });

  test("the public manifest has salted leaves that build the root and no content hashes", async () => {
    const res = await app.request(`/v1/evidence/${capture.manifest.root}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const manifest = JSON.parse(text);
    expect(manifest).toEqual(capture.manifest);
    expect(verifyManifest(manifest)).toBe(true);
    expect(text).not.toMatch(/salt|content_hash/);
    for (const item of capture.items) {
      expect(text).not.toContain(createHash("sha256").update(item.bytes).digest("hex"));
    }
  });

  test("an arbiter gets one item with a disclosure, and the access is recorded", async () => {
    const url = `/v1/evidence/${capture.manifest.root}/items/3`;
    expect((await app.request(url, { headers: arbiter })).status).toBe(422);
    const res = await app.request(`${url}?reason=dispute%20D-1`, { headers: arbiter });
    expect(res.status).toBe(200);
    const { disclosure, bytes } = (await res.json()) as { disclosure: Disclosure; bytes: string };
    expect(disclosure.type).toBe("dom.snapshot");
    const raw = Uint8Array.from(Buffer.from(bytes, "base64"));
    expect(verifyDisclosure(capture.manifest.root, disclosure, raw)).toBe(true);
    expect(raw).toEqual(capture.items[3]?.bytes);

    const audit = await testDb
      .select()
      .from(evidenceAccess)
      .where(eq(evidenceAccess.root, Buffer.from(capture.manifest.root.slice(2), "hex")));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      index: 3,
      client: "evidence-test",
      action: "disclose",
      reason: "dispute D-1",
    });

    expect((await app.request(`${url}?reason=x`)).status).toBe(401);
    const missing = await app.request(`/v1/evidence/${capture.manifest.root}/items/17?reason=x`, {
      headers: arbiter,
    });
    expect(missing.status).toBe(404);
  });

  test("an unauthenticated upload is refused before its body is read", async () => {
    const res = await app.request("/v1/evidence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(401);
  });

  test("a mandate that is not active takes no evidence", async () => {
    const draft = await mandate("DRAFT");
    const res = await post(uploadBody(draft, resalted(capture)));
    expect(res.status).toBe(409);
    expect(await problemType(res)).toMatch(/mandate-not-active$/);
  });

  test("a mandate takes a bounded number of bundles", async () => {
    const full = await mandate();
    for (let k = 0; k < EVIDENCE_BUNDLES_PER_MANDATE; k++) {
      expect((await post(uploadBody(full, resalted(capture)))).status).toBe(201);
    }
    const over = await post(uploadBody(full, resalted(capture)));
    expect(over.status).toBe(409);
    expect(await problemType(over)).toMatch(/evidence-limit$/);
  });

  test("a manifest the items do not build is refused", async () => {
    const body = uploadBody(mandateId, resalted(capture));
    body.manifest = { ...body.manifest, root: capture.manifest.root };
    const res = await post(body);
    expect(res.status).toBe(422);
    expect(await problemType(res)).toMatch(/evidence-root-mismatch$/);
  });

  test("two items with the same salt are refused", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const items = capture.items.map((i) => ({ ...i, salt }));
    const body = uploadBody(mandateId, { manifest: { ...capture.manifest }, items });
    const res = await post(body);
    expect(res.status).toBe(422);
  });

  test("a public item that still holds PII is refused, however it is written", async () => {
    for (const leak of [
      "contact: sales@northfield-outfitters.com",
      "GET /track?email=ada%40example.org",
      "call (415) 555-0100",
      "ada&#64;example.org",
    ]) {
      const items: SealedItem[] = capture.items.map((i) =>
        i.type === "llm.observation" ? { ...i, bytes: new TextEncoder().encode(leak) } : i,
      );
      const res = await post(uploadBody(mandateId, resalted({ items })));
      expect(res.status, leak).toBe(422);
      expect(await problemType(res)).toMatch(/evidence-pii$/);
    }
  });

  test("a bundle over 1 MiB is accepted", async () => {
    const big = new TextEncoder().encode("Trail Runner 2 ".repeat(100_000));
    const items: SealedItem[] = capture.items.map((i) =>
      i.type === "llm.observation" ? { ...i, bytes: big } : i,
    );
    const res = await post(uploadBody(mandateId, resalted({ items })));
    expect(res.status).toBe(201);
  });

  test("an original that does not open with the evidence identity is refused", async () => {
    const items: SealedItem[] = [
      ...capture.items,
      {
        type: "dom.snapshot.original",
        mediaType: "application/octet-stream",
        bytes: randomBytes(256),
        salt: crypto.getRandomValues(new Uint8Array(32)),
      },
    ];
    const res = await post(uploadBody(mandateId, resalted({ items })));
    expect(res.status).toBe(422);
    expect(await problemType(res)).toMatch(/evidence-undecryptable$/);

    // Stored where no identity is configured, it still decrypts to a problem, not a crash.
    const bare = appWith();
    const stored = resalted({ items });
    expect((await post(uploadBody(mandateId, stored), writer, bare)).status).toBe(201);
    const opened = await app.request(
      `/v1/evidence/${stored.manifest.root}/items/${items.length - 1}?decrypt=1&reason=x`,
      { headers: as("evidence:disclose", "evidence:decrypt") },
    );
    expect(opened.status).toBe(422);
    expect(await problemType(opened)).toMatch(/evidence-undecryptable$/);
  });

  test.skipIf(!buyerEmail)(
    "an original opens only for an arbiter that may decrypt, and is recorded",
    async () => {
      const checkout = await store.capture("checkout.html", {
        recipient: keys.recipient,
        pii: { email: buyerEmail as string },
        fill: { "#email": buyerEmail as string },
      });
      expect((await post(uploadBody(mandateId, checkout))).status).toBe(201);
      const index = checkout.items.findIndex((i) => i.type === "dom.snapshot.original");
      expect(index).toBeGreaterThan(0);
      const url = `/v1/evidence/${checkout.manifest.root}/items/${index}?reason=dispute%20D-2`;

      const sealed = (await (await app.request(url, { headers: arbiter })).json()) as {
        bytes: string;
      };
      expect(Buffer.from(sealed.bytes, "base64").toString("latin1")).not.toContain(buyerEmail);
      expect((await app.request(`${url}&decrypt=1`, { headers: arbiter })).status).toBe(403);

      const opened = await app.request(`${url}&decrypt=1`, {
        headers: as("evidence:disclose", "evidence:decrypt"),
      });
      expect(opened.status).toBe(200);
      const { bytes } = (await opened.json()) as { bytes: string };
      expect(Buffer.from(bytes, "base64").toString("utf8")).toContain(buyerEmail);

      const audit = await testDb
        .select()
        .from(evidenceAccess)
        .where(eq(evidenceAccess.root, Buffer.from(checkout.manifest.root.slice(2), "hex")));
      expect(audit.map((a) => a.action).sort()).toEqual(["decrypt", "disclose"]);
    },
  );
});
