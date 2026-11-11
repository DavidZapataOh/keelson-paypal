import { API } from "./config";

/** An RFC 9457 problem the API answered with. */
export class ApiError extends Error {
  override name = "ApiError";
  readonly status: number;
  readonly slug: string;
  readonly fields: readonly string[];
  constructor(status: number, slug: string, message: string, fields: readonly string[] = []) {
    super(message);
    this.status = status;
    this.slug = slug;
    this.fields = fields;
  }
}

export async function send<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, credentials: "include" });
  if (res.status === 204) return undefined as T;
  if (res.ok) return (await res.json()) as T;
  const body = (await res.json().catch(() => ({}))) as {
    type?: string;
    title?: string;
    detail?: string;
    fields?: string[];
  };
  throw new ApiError(
    res.status,
    body.type?.split("/").pop() ?? "unknown",
    body.detail ?? body.title ?? `The API answered ${res.status}.`,
    body.fields ?? [],
  );
}

export const get = <T>(path: string): Promise<T> => send<T>(path, { cache: "no-store" });

export const post = <T>(path: string, body?: unknown, headers: Record<string, string> = {}) =>
  send<T>(path, {
    method: "POST",
    headers: {
      "idempotency-key": crypto.randomUUID(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

export const del = (path: string, body?: unknown) =>
  send<void>(path, {
    method: "DELETE",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

export const put = <T>(path: string, body: unknown) =>
  send<T>(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
