import { ApiError } from "@paypal/paypal-server-sdk";

export interface PayPalErrorDetail {
  issue: string;
  description?: string;
  field?: string;
}

interface PayPalErrorBody {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: PayPalErrorDetail[];
  error?: string;
  error_description?: string;
}

/** A PayPal API failure; `name` carries PayPal's error name, e.g. `RESOURCE_NOT_FOUND`. */
/**
 * PayPal refused the access token itself, not the request: it is invalid or revoked (401), or it
 * lacks a scope the app has since been granted (403 `NOT_AUTHORIZED`). A new token may pass.
 */
export function isTokenRefused(err: unknown): boolean {
  return (
    err instanceof PayPalError &&
    (err.status === 401 || (err.status === 403 && err.name === "NOT_AUTHORIZED"))
  );
}

export class PayPalError extends Error {
  readonly status: number;
  readonly debugId: string | undefined;
  readonly details: PayPalErrorDetail[];

  constructor(status: number, body: PayPalErrorBody, debugHeader?: string | null) {
    super(body.message ?? body.error_description ?? `PayPal request failed with HTTP ${status}`);
    this.name = body.name ?? body.error ?? "PAYPAL_ERROR";
    this.status = status;
    this.debugId = body.debug_id ?? debugHeader ?? undefined;
    this.details = body.details ?? [];
  }
}

function parseBody(value: unknown): PayPalErrorBody {
  if (typeof value === "string") {
    try {
      return parseBody(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === "object" ? (value as PayPalErrorBody) : {};
}

/** Converts an SDK `ApiError` to a `PayPalError`; other errors pass through unchanged. */
export function fromSdkError(e: unknown): unknown {
  if (!(e instanceof ApiError)) return e;
  const body = parseBody(e.result ?? e.body);
  return new PayPalError(e.statusCode, body, e.headers["paypal-debug-id"]);
}

export async function fromResponse(res: Response): Promise<PayPalError> {
  const text = await res.text();
  return new PayPalError(res.status, parseBody(text), res.headers.get("paypal-debug-id"));
}
