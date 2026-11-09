import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startTelemetry } from "../src/tracing.ts";

const live =
  process.env.KEELSON_LIVE === "1" &&
  process.env.RELAYER_AWS_ACCESS_KEY_ID &&
  process.env.KEELSON_OPERATOR_KEY;

// The SDK starts before anything loads `pg`, as the API's entry point does.
const exporter = new InMemorySpanExporter();
const sdk = await startTelemetry({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });

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
    await sdk.shutdown();
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

  test("no span carries a secret, the buyer or an amount", () => {
    const values = exporter
      .getFinishedSpans()
      .flatMap((s) => [s.name, ...Object.values(s.attributes).map(String)]);
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
