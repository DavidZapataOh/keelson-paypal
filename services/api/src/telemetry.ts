import { startTelemetry } from "./tracing.ts";

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_TRACES_EXPORTER) {
  const sdk = await startTelemetry();
  process.once("SIGTERM", () => {
    void sdk.shutdown();
  });
}
