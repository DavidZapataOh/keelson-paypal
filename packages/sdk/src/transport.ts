import {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  errorFor,
  KeelsonError,
  OutcomeUnknownError,
} from "./errors.ts";

/** Something that hands out a bearer token for Keelson's API. */
export interface AuthProvider {
  /** A valid access token; `force` asks for a new one after the API refused the last. */
  token(opts?: { force?: boolean }): Promise<string>;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Defaults to a fresh UUID per call on every POST, kept across its retries. */
  idempotencyKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** `false` sends no token: the operation is public. */
  auth?: boolean;
  /** How to read the answer: JSON (default), raw bytes, the open response (a stream), or none. */
  as?: "json" | "bytes" | "stream" | "none";
}

export interface APIResponse<T> {
  data: T;
  response: Response;
  /** The `X-Request-Id` the API gave this call, for support. */
  requestId: string | null;
}

export interface TransportOptions {
  baseUrl: string;
  maxRetries: number;
  timeoutMs: number;
  fetch: typeof fetch;
  auth: () => AuthProvider;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Refuses to send a token anywhere but over TLS or to this machine. */
export function checkBaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new KeelsonError(`baseUrl must use https: ${raw}`);
  }
  return url;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Exponential backoff from 0.5 s to 8 s with up to 25 % jitter, or the server's `Retry-After`. */
function delayMs(attempt: number, response?: Response): number {
  const header = response?.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (ms >= 0 && ms <= 60_000) return ms;
  }
  return Math.min(500 * 2 ** attempt, 8_000) * (1 - 0.25 * Math.random());
}

function retryable(status: number, type: string | undefined): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    (status === 409 && type === "idempotency-in-progress")
  );
}

const COUNTERSIGN = "/v1/countersign";

/** One call to Keelson's API: auth, idempotency, retries, a timeout per attempt and typed errors. */
export async function send<T>(
  o: TransportOptions,
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<APIResponse<T>> {
  const url = new URL(path, o.baseUrl);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const headers = new Headers(opts.headers);
  headers.set(
    "accept",
    opts.as === "bytes" ? "*/*" : opts.as === "stream" ? "text/event-stream" : "application/json",
  );
  const raw = opts.body instanceof Uint8Array;
  if (opts.body !== undefined && !raw) headers.set("content-type", "application/json");
  if (method === "POST") headers.set("idempotency-key", opts.idempotencyKey ?? crypto.randomUUID());
  const body =
    opts.body === undefined
      ? null
      : opts.body instanceof Uint8Array
        ? (opts.body as Uint8Array<ArrayBuffer>)
        : JSON.stringify(opts.body);
  const provider = opts.auth === false ? undefined : o.auth();
  let refreshed = false;
  let force = false;

  for (let attempt = 0; ; attempt++) {
    if (provider) headers.set("authorization", `Bearer ${await provider.token({ force })}`);
    force = false;
    const timeout = AbortSignal.timeout(o.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await o.fetch(url, { method, headers, body, signal });
    } catch (cause) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      const err = timeout.aborted
        ? new APIConnectionTimeoutError(`No answer from ${url.origin} in ${o.timeoutMs} ms`, {
            cause,
          })
        : new APIConnectionError(`Could not reach ${url.origin}`, { cause });
      if (attempt < o.maxRetries) {
        await sleep(delayMs(attempt), opts.signal);
        continue;
      }
      throw lost(method, path, opts.body, err);
    }
    const requestId = response.headers.get("x-request-id");
    if (response.ok) {
      if (opts.as === "stream") return { data: undefined as T, response, requestId };
      const data =
        opts.as === "bytes"
          ? new Uint8Array(await response.arrayBuffer())
          : opts.as === "none" || response.status === 204
            ? undefined
            : await response.json();
      return { data: data as T, response, requestId };
    }
    const problem = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const err = errorFor(response.status, problem, requestId);
    if (
      err instanceof AuthenticationError &&
      provider &&
      !refreshed &&
      /invalid_token/.test(response.headers.get("www-authenticate") ?? "")
    ) {
      refreshed = true;
      force = true;
      attempt--;
      continue;
    }
    if (retryable(response.status, err.type) && attempt < o.maxRetries) {
      await sleep(delayMs(attempt, response), opts.signal);
      continue;
    }
    throw response.status >= 500 ? lost(method, path, opts.body, err) : err;
  }
}

/** A countersign whose answer never came may have bought the cart: say so, never retry it. */
function lost(method: string, path: string, body: unknown, err: KeelsonError): KeelsonError {
  const requestId = (body as { requestId?: unknown } | undefined)?.requestId;
  if (method === "POST" && path === COUNTERSIGN && typeof requestId === "string") {
    return new OutcomeUnknownError(requestId, { cause: err });
  }
  return err;
}
