import { NodeSDK } from "@opentelemetry/sdk-node";

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({ serviceName: "keelson-api" });
  sdk.start();
  process.once("SIGTERM", () => {
    void sdk.shutdown();
  });
}
