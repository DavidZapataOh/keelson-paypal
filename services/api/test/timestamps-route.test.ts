import { readFileSync } from "node:fs";
import { and, eq, timestamps } from "@keelson/db";
import { pino } from "pino";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { testDb, testKv } from "./setup.ts";

// Real DigiCert and Sigstore tokens over one imprint, captured from the live TSAs.
const fixtures = new URL("../../../packages/timestamp/test/tokens/", import.meta.url);
const captured = JSON.parse(readFileSync(new URL("tokens.json", fixtures), "utf8")) as {
  imprint: string;
  tokens: Record<string, { file: string; genTime: string; serial: string }>;
};
const hash = Buffer.from(captured.imprint, "hex");
const token = (tsa: "digicert" | "sigstore") =>
  readFileSync(new URL(captured.tokens[tsa]?.file as string, fixtures));
const stamped = (tsa: "digicert" | "sigstore") => ({
  status: "stamped",
  token: token(tsa),
  genTime: new Date(captured.tokens[tsa]?.genTime as string),
  serial: captured.tokens[tsa]?.serial as string,
  latencyMs: 300,
  attempts: 1,
  stampedAt: new Date(),
});

const app = createApp({ db: testDb, kv: testKv, log: pino({ level: "silent" }) });

test("an unknown hash is not found", async () => {
  const res = await app.request(`/v1/timestamps/${"ab".repeat(32)}`);
  expect(res.status).toBe(404);
  expect(((await res.json()) as { type: string }).type).toMatch(/\/timestamps-not-found$/);
});

test("a malformed hash is refused", async () => {
  const res = await app.request(`/v1/timestamps/${"AB".repeat(32)}`);
  expect(res.status).toBe(422);
});

test("a half-stamped hash names what is pending and is not cached; a stamped one is", async () => {
  await testDb.insert(timestamps).values([
    { hash, kind: "leaf", tsa: "digicert", role: "primary", ...stamped("digicert") },
    { hash, kind: "leaf", tsa: "sigstore", role: "primary" },
  ]);
  const half = await app.request(`/v1/timestamps/${captured.imprint}`);
  expect(half.status).toBe(200);
  expect(half.headers.get("cache-control")).toBe("no-store");
  const halfBody = (await half.json()) as { stamps: { tsa: string }[]; pending: string[] };
  expect(halfBody.stamps.map((s) => s.tsa)).toEqual(["digicert"]);
  expect(halfBody.pending).toEqual(["sigstore"]);

  await testDb
    .update(timestamps)
    .set(stamped("sigstore"))
    .where(and(eq(timestamps.hash, hash), eq(timestamps.tsa, "sigstore")));
  const full = await app.request(`/v1/timestamps/${captured.imprint}`);
  expect(full.status).toBe(200);
  expect(full.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(await full.json()).toEqual({
    hash: captured.imprint,
    stamps: (["digicert", "sigstore"] as const).map((tsa) => ({
      tsa,
      role: "primary",
      token: token(tsa).toString("base64"),
      genTime: captured.tokens[tsa]?.genTime,
      serial: captured.tokens[tsa]?.serial,
    })),
    pending: [],
  });
});
