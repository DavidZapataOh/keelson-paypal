import { timings } from "./server-timing.ts";
import { startTelemetry } from "./tracing.ts";

// With an OTLP exporter configured, spans go there; otherwise they only time each purchase's
// steps for `Server-Timing`.
const sdk = await startTelemetry(
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_TRACES_EXPORTER
    ? {}
    : { spanProcessors: [timings] },
);
process.once("SIGTERM", () => {
  void sdk.shutdown();
});
