import { type Attributes, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { NodeSDK, NodeSDKConfiguration } from "@opentelemetry/sdk-node";

const tracer = trace.getTracer("@keelson/api");

/**
 * Starts the OpenTelemetry Node SDK with the outbound HTTP (undici), inbound HTTP and Postgres
 * instrumentations. Exporters come from `config` or, when it names none, from the SDK's
 * `OTEL_*` environment variables. Modules loaded before this call are not instrumented.
 */
export async function startTelemetry(config: Partial<NodeSDKConfiguration> = {}): Promise<NodeSDK> {
  const [{ NodeSDK }, { UndiciInstrumentation }, { HttpInstrumentation }, { PgInstrumentation }] =
    await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/instrumentation-undici"),
      import("@opentelemetry/instrumentation-http"),
      import("@opentelemetry/instrumentation-pg"),
    ]);
  const sdk = new NodeSDK({
    serviceName: "keelson-api",
    instrumentations: [
      new UndiciInstrumentation({
        // RPC providers such as Alchemy carry the API key in the path; spans keep the host only.
        startSpanHook: (request) => {
          const url = new URL(request.path, request.origin);
          if (!url.hostname.endsWith(".alchemy.com")) return {};
          return { "url.full": `${url.origin}/REDACTED`, "url.path": "/REDACTED" };
        },
      }),
      new HttpInstrumentation(),
      new PgInstrumentation({ requireParentSpan: true }),
    ],
    ...config,
  });
  sdk.start();
  return sdk;
}

/** Runs `f` in an active span named `name`, recording a throw as the span's error. */
export function span<T>(
  name: string,
  attributes: Attributes,
  f: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (s) => {
    try {
      return await f(s);
    } catch (err) {
      s.recordException(err as Error);
      s.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      s.end();
    }
  });
}
