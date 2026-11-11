from __future__ import annotations

from typing import Any


class KeelsonError(Exception):
    """The base of every error this SDK raises."""


class APIError(KeelsonError):
    """An RFC 9457 problem the API answered, or an OAuth error of its authorization server."""

    def __init__(self, status: int, problem: dict[str, Any], request_id: str | None) -> None:
        raw_type = problem.get("type")
        self.status = status
        self.type: str | None = (
            raw_type.rsplit("/", 1)[-1]
            if isinstance(raw_type, str)
            else problem.get("error")
            if isinstance(problem.get("error"), str)
            else None
        )
        self.title: str | None = problem.get("title") if isinstance(problem.get("title"), str) else None
        detail = problem.get("detail", problem.get("error_description"))
        self.detail: str | None = detail if isinstance(detail, str) else None
        self.problem = problem
        self.request_id = request_id
        head = ": ".join(p for p in (self.title or f"HTTP {status}", self.detail) if p)
        super().__init__(f"{head} ({status}{' ' + self.type if self.type else ''})")


class BadRequestError(APIError): ...


class AuthenticationError(APIError): ...


class PermissionDeniedError(APIError): ...


class NotFoundError(APIError): ...


class ConflictError(APIError): ...


class UnprocessableEntityError(APIError): ...


class RateLimitError(APIError): ...


class InternalServerError(APIError): ...


_BY_STATUS: dict[int, type[APIError]] = {
    400: BadRequestError,
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    422: UnprocessableEntityError,
    429: RateLimitError,
}


def error_for(status: int, problem: dict[str, Any], request_id: str | None) -> APIError:
    cls = _BY_STATUS.get(status) or (InternalServerError if status >= 500 else APIError)
    return cls(status, problem, request_id)


class APIConnectionError(KeelsonError):
    """No answer reached the client: the connection failed or was reset."""


class APIConnectionTimeoutError(APIConnectionError):
    """An attempt took longer than the timeout."""


class OutcomeUnknownError(KeelsonError):
    """A countersign was sent and no answer says what happened to it: the purchase may exist.

    Never send it again; read it with ``purchases.wait_for(request_id)``.
    """

    def __init__(self, request_id: str) -> None:
        self.request_id = request_id
        super().__init__(
            f"The countersign of {request_id} was sent and its outcome is unknown. "
            f'Do not send it again; call purchases.wait_for("{request_id}").'
        )


class MandateRequestClosedError(KeelsonError):
    """The user denied the mandate request, or it expired before they answered."""

    def __init__(self, state: str) -> None:
        self.state = state
        super().__init__(
            "The user declined the mandate request. Do not ask again unless they ask you to."
            if state == "DENIED"
            else "The mandate request expired before the user answered."
        )


class VerifierUnavailable(KeelsonError):
    """The offline verifier could not run: it needs Node.js 20 or later."""
