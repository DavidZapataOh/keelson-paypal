import type { Keelson } from "@keelson/agent/checkout";

/** A `problem+json` answer of Keelson's API, as the tool error the model reads. */
export class KeelsonError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "KeelsonError";
  }
}

/** Calls Keelson's API and returns the response body, or throws its problem. */
export async function call(
  keelson: Keelson,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await keelson.request(path, init);
  if (res.ok) return res;
  const problem = (await res.json().catch(() => ({}))) as {
    type?: string;
    title?: string;
    detail?: string;
  };
  const type = problem.type?.split("/").at(-1);
  const reason = [problem.title ?? `HTTP ${res.status}`, problem.detail].filter(Boolean).join(": ");
  throw new KeelsonError(res.status, type, `${reason} (${res.status}${type ? ` ${type}` : ""})`);
}

/** A JSON body sent with a fresh idempotency key. */
export const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
  body: JSON.stringify(body),
});
