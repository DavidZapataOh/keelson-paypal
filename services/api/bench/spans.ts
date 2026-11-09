import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { startTelemetry } from "../src/tracing.ts";

/** Every span this process ends, kept in memory. Import first, before anything loads `pg`. */
export const spans = new InMemorySpanExporter();
export const sdk = await startTelemetry({
  spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
});
