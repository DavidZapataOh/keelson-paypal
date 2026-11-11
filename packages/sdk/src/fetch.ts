import type { TokenProvider } from "./auth.ts";

export interface RetryOptions {
  /** Attempts after the first. Defaults to 3. */
  maxRetries?: number;
  /** The first backoff, doubled on each retry with full jitter. Defaults to 500 ms. */
  baseDelayMs?: number;
  /** The longest wait, `Retry-After` included. Defaults to 30 s. */
  maxDelayMs?: number;
}

/** Statuses answered before the request took effect, or by a gateway: safe to send again. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function retryAfterMs(res: Response): number | undefined {
  const value = res.headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function inProgress(res: Response): Promise<boolean> {
  if (res.status !== 409) return false;
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { type?: unknown };
  return typeof body.type === "string" && body.type.endsWith("/idempotency-in-progress");
}

const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
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

/**
 * The `fetch` every SDK call goes through. It sends the bearer token, gives each POST an
 * `Idempotency-Key` (kept across its retries, so Keelson runs it at most once), and retries
 * network failures, `429`, `5xx` and an in-progress idempotent request with exponential backoff,
 * honoring `Retry-After`. A `401 invalid_token` gets one fresh token.
 */
export function keelsonFetch(o: {
  auth?: TokenProvider | undefined;
  retry?: RetryOptions | undefined;
  fetch?: typeof fetch | undefined;
}): typeof fetch {
  const send = o.fetch ?? fetch;
  const maxRetries = o.retry?.maxRetries ?? 3;
  const base = o.retry?.baseDelayMs ?? 500;
  const max = o.retry?.maxDelayMs ?? 30_000;
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "POST" && !request.headers.has("idempotency-key")) {
      request.headers.set("idempotency-key", crypto.randomUUID());
    }
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const req = request.clone();
      if (o.auth) req.headers.set("authorization", `Bearer ${await o.auth.token()}`);
      let res: Response;
      try {
        res = await send(req);
      } catch (err) {
        if (request.signal.aborted || attempt >= maxRetries) throw err;
        await sleep(Math.random() * Math.min(max, base * 2 ** attempt), request.signal);
        continue;
      }
      if (
        res.status === 401 &&
        o.auth &&
        !refreshed &&
        res.headers.get("www-authenticate")?.includes("invalid_token")
      ) {
        o.auth.invalidate();
        refreshed = true;
        attempt--;
        continue;
      }
      if (attempt >= maxRetries || !(RETRYABLE.has(res.status) || (await inProgress(res)))) {
        return res;
      }
      const wait = retryAfterMs(res) ?? Math.random() * base * 2 ** attempt;
      await res.body?.cancel();
      await sleep(Math.min(max, wait), request.signal);
    }
  };
}
