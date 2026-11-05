if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const sdk = new NodeSDK({ serviceName: "keelson-api" });
  sdk.start();
  process.once("SIGTERM", () => {
    void sdk.shutdown();
  });
}
