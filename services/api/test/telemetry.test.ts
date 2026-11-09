import { serve } from "@hono/node-server";
import { SpanKind } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { span, startTelemetry } from "../src/tracing.ts";

const live =
  process.env.KEELSON_LIVE === "1" &&
  process.env.RELAYER_AWS_ACCESS_KEY_ID &&
  process.env.KEELSON_OPERATOR_KEY;

// The SDK starts before anything loads `pg`, as the API's entry point does.
const exporter = new InMemorySpanExporter();
const sdk = await startTelemetry({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });

afterAll(() => sdk.shutdown());

/** Every name and value the spans carry, once the SDK has exported what already ended. */
const everything = async () => {
  await new Promise((r) => setTimeout(r, 200));
  return exporter
    .getFinishedSpans()
    .flatMap((s) => [
      s.name,
      ...Object.values(s.attributes).map(String),
      ...s.events.flatMap((e) => [e.name, ...Object.values(e.attributes ?? {}).map(String)]),
    ]);
};

test("a failed span records the error's name, not its message", async () => {
  await expect(
    span("probe.fail", {}, async () => {
      throw new Error("Key (amount)=(4242) already exists");
    }),
  ).rejects.toThrow();
  const values = await everything();
  expect(values).toContain("Error");
  for (const v of values) expect(v).not.toContain("4242");
});

test("inbound requests make no span, and no span keeps a query", async () => {
  const app = new Hono().get("/cb", (c) => c.text("ok"));
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as { port: number };
  try {
    await (await fetch(`http://127.0.0.1:${port}/cb?code=oauth-code-1234&token=tok-5678`)).text();
  } finally {
    server.close();
  }
  for (const v of await everything()) {
    for (const secret of ["oauth-code-1234", "tok-5678"]) expect(v).not.toContain(secret);
  }
  expect(exporter.getFinishedSpans().filter((s) => s.kind === SpanKind.SERVER)).toEqual([]);
});

describe.skipIf(!live)("purchase tracing (live)", { timeout: 900_000 }, () => {
  let release: () => Promise<void>;
  let purchaseId: string;

  beforeAll(async () => {
    const { pipelineHarness } = await import("./purchase-live.ts");
    const h = await pipelineHarness();
    release = h.close;
    const m = await h.activeMandate(1_000);
    const res = await h.countersign(m, 100);
    expect([200, 202], JSON.stringify(res.out).slice(0, 400)).toContain(res.status);
    purchaseId = res.out.purchaseId as string;
    // The local log signs with throwaway keys, so the Alibi does not verify and the purchase
    // stops after the log step; the deployed path to the capture is traced by the bench.
    await h.settled(purchaseId);
  }, 900_000);

  afterAll(async () => {
    await release?.();
  });

  test("each step of the purchase is a span, in order, with its outbound calls inside", () => {
    const spans = exporter.getFinishedSpans();
    const own = spans
      .filter((s) => s.attributes["purchase.id"] === purchaseId)
      .sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1]);
    const names = own.map((s) => s.name);
    expect(names.slice(0, 1)).toEqual(["purchase.COUNTERSIGNED"]);
    expect(names).toEqual(expect.arrayContaining(["purchase.LOGGED", "purchase.COVERED"]));
    for (const s of own) expect(s.attributes["countersign.mode"]).toBe("2of2");

    const childrenOf = (name: string) => {
      const parent = own.find((s) => s.name === name);
      return spans.filter((s) => s.parentSpanContext?.spanId === parent?.spanContext().spanId);
    };
    const hosts = (name: string) =>
      new Set(childrenOf(name).map((s) => s.attributes["server.address"]));
    // Both legs are called from the countersign span, the log from the log step.
    const legs = [process.env.TEE_A_URL, process.env.TEE_B_URL].map((u) => new URL(u as string));
    for (const leg of legs) expect([...hosts("purchase.COUNTERSIGNED")]).toContain(leg.hostname);
    expect([...hosts("purchase.LOGGED")]).toContain("127.0.0.1");
    expect(childrenOf("purchase.LOGGED").some((s) => s.name.startsWith("pg."))).toBe(true);
  });

  test("no span carries a secret, the buyer or an amount", async () => {
    const values = await everything();
    const rpcKey = new URL(process.env.ARBITRUM_SEPOLIA_RPC_URL as string).pathname.split("/")[2];
    const forbidden = [
      process.env.PAYPAL_SANDBOX_BUYER_EMAIL,
      process.env.KEELSON_TEE_TOKEN,
      process.env.LOG_WRITE_TOKEN,
      process.env.PAYPAL_CLIENT_SECRET,
      rpcKey,
      "Bearer ",
      "A21AA",
      "1.00",
    ].filter((v): v is string => Boolean(v));
    for (const v of values) for (const f of forbidden) expect(v).not.toContain(f);
  });
});
