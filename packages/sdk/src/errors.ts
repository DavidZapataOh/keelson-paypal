/** The base of every error this SDK throws. */
export class KeelsonError extends Error {
  override name = "KeelsonError";
}

/** An RFC 9457 problem the API answered, or an OAuth error of its authorization server. */
export class APIError extends KeelsonError {
  override name = "APIError";
  /** The last segment of the problem's `type`, e.g. `purchase-exists`, or the OAuth `error`. */
  readonly type: string | undefined;
  readonly title: string | undefined;
  readonly detail: string | undefined;
  /** Every member of the problem, e.g. `purchaseId` or `approval`. */
  readonly problem: Readonly<Record<string, unknown>>;

  constructor(
    readonly status: number,
    problem: Record<string, unknown>,
    readonly requestId: string | null,
  ) {
    const type =
      typeof problem.type === "string"
        ? problem.type.split("/").at(-1)
        : typeof problem.error === "string"
          ? problem.error
          : undefined;
    const title = typeof problem.title === "string" ? problem.title : undefined;
    const detail =
      typeof problem.detail === "string"
        ? problem.detail
        : typeof problem.error_description === "string"
          ? problem.error_description
          : undefined;
    super(
      `${[title ?? `HTTP ${status}`, detail].filter(Boolean).join(": ")} (${status}${type ? ` ${type}` : ""})`,
    );
    this.type = type;
    this.title = title;
    this.detail = detail;
    this.problem = problem;
  }
}

export class BadRequestError extends APIError {
  override name = "BadRequestError";
}
export class AuthenticationError extends APIError {
  override name = "AuthenticationError";
}
export class PermissionDeniedError extends APIError {
  override name = "PermissionDeniedError";
}
export class NotFoundError extends APIError {
  override name = "NotFoundError";
}
export class ConflictError extends APIError {
  override name = "ConflictError";
}
export class UnprocessableEntityError extends APIError {
  override name = "UnprocessableEntityError";
}
export class RateLimitError extends APIError {
  override name = "RateLimitError";
}
export class InternalServerError extends APIError {
  override name = "InternalServerError";
}

/** Builds the error class that matches a status. */
export function errorFor(
  status: number,
  problem: Record<string, unknown>,
  requestId: string | null,
): APIError {
  const Class =
    status === 400
      ? BadRequestError
      : status === 401
        ? AuthenticationError
        : status === 403
          ? PermissionDeniedError
          : status === 404
            ? NotFoundError
            : status === 409
              ? ConflictError
              : status === 422
                ? UnprocessableEntityError
                : status === 429
                  ? RateLimitError
                  : status >= 500
                    ? InternalServerError
                    : APIError;
  return new Class(status, problem, requestId);
}

/** No answer reached the client: the connection failed or was reset. */
export class APIConnectionError extends KeelsonError {
  override name = "APIConnectionError";
}

/** An attempt took longer than `timeoutMs`. */
export class APIConnectionTimeoutError extends APIConnectionError {
  override name = "APIConnectionTimeoutError";
}

/**
 * A countersign was sent and no answer says what happened to it: the purchase may exist. Never
 * send it again; read it with `purchases.waitFor(requestId)`.
 */
export class OutcomeUnknownError extends KeelsonError {
  override name = "OutcomeUnknownError";
  constructor(
    /** The request id the countersign carried, which is also the purchase's id. */
    readonly requestId: string,
    options?: { cause?: unknown },
  ) {
    super(
      `The countersign of ${requestId} was sent and its outcome is unknown. Do not send it again; call purchases.waitFor("${requestId}").`,
      options,
    );
  }
}

/** The user denied the mandate request, or it expired before they answered. */
export class MandateRequestClosedError extends KeelsonError {
  override name = "MandateRequestClosedError";
  constructor(readonly state: "DENIED" | "EXPIRED") {
    super(
      state === "DENIED"
        ? "The user declined the mandate request. Do not ask again unless they ask you to."
        : "The mandate request expired before the user answered.",
    );
  }
}
