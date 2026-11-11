import { type Attributes, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { NodeSDK, NodeSDKConfiguration } from "@opentelemetry/sdk-node";

const tracer = trace.getTracer("@keelson/api");

/**
 * Starts the OpenTelemetry Node SDK with the outbound HTTP (undici) and Postgres
 * instrumentations. Exporters come from `config` or, when it names none, from the SDK's
 * `OTEL_*` environment variables. Modules loaded before this call are not instrumented.
 */
export async function startTelemetry(config: Partial<NodeSDKConfiguration> = {}): Promise<NodeSDK> {
  const [{ NodeSDK }, { UndiciInstrumentation }, { PgInstrumentation }] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/instrumentation-undici"),
    import("@opentelemetry/instrumentation-pg"),
  ]);
  const sdk = new NodeSDK({
    serviceName: "keelson-api",
    instrumentations: [
      new UndiciInstrumentation({
        // Queries can carry tokens, and RPC providers such as Alchemy carry the API key in the
        // path: spans keep the path of other hosts and neither the query nor a key.
        startSpanHook: (request) => {
          const url = new URL(request.path, request.origin);
          const path = url.hostname.endsWith(".alchemy.com") ? "/REDACTED" : url.pathname;
          return { "url.full": `${url.origin}${path}`, "url.path": path, "url.query": "" };
        },
      }),
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
      // The name only: messages can carry ids, amounts or what a database row held.
      const name = err instanceof Error ? err.name : typeof err;
      s.recordException({ name });
      s.setStatus({ code: SpanStatusCode.ERROR, message: name });
      throw err;
    } finally {
      s.end();
    }
  });
}

/** Records a span named `name` from `startedAt` (epoch ms) to now, under the active span. */
export function mark(name: string, startedAt: number): void {
  tracer.startSpan(name, { startTime: startedAt }).end();
}
