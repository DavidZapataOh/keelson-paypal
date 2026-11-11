"""The client every generated call goes through: bearer, Idempotency-Key and retries."""

from __future__ import annotations

import asyncio
import json
import random
import time
import uuid
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from http import HTTPStatus
from typing import Any, Protocol, TypeVar, cast

import httpx2

from .auth import KEELSON_API, BearerAuth, TokenProvider
from .generated.client import AuthenticatedClient
from .generated.models import Problem

T = TypeVar("T")
T_co = TypeVar("T_co", covariant=True)


class _Answer(Protocol[T_co]):
    """What a generated ``*_detailed`` call returns."""

    @property
    def status_code(self) -> HTTPStatus: ...
    @property
    def content(self) -> bytes: ...
    @property
    def parsed(self) -> T_co | None: ...


_RETRYABLE = frozenset({408, 425, 429, 500, 502, 503, 504})
"""Statuses answered before the request took effect, or by a gateway: safe to send again."""


@dataclass(frozen=True)
class Retry:
    max_retries: int = 3
    """Attempts after the first."""
    base_delay: float = 0.5
    """The first backoff in seconds, doubled on each retry with full jitter."""
    max_delay: float = 30.0
    """The longest wait in seconds, ``Retry-After`` included."""


DEFAULT_RETRY = Retry()


class KeelsonError(Exception):
    """An RFC 9457 problem Keelson's API answered."""

    def __init__(self, status: int, problem: dict[str, Any]) -> None:
        self.status = status
        self.problem = problem
        kind = problem.get("type")
        self.type: str | None = kind.rsplit("/", 1)[-1] if isinstance(kind, str) else None
        title = problem.get("title") or f"HTTP {status}"
        detail = f": {problem['detail']}" if problem.get("detail") else ""
        super().__init__(f"{title}{detail} ({status}{f' {self.type}' if self.type else ''})")


def unwrap(response: _Answer[T | Problem]) -> T:
    """The parsed answer of a generated ``*_detailed`` call, or its problem as a
    :class:`KeelsonError`."""
    if 200 <= response.status_code < 300:
        return cast(T, response.parsed)
    try:
        problem = json.loads(response.content) if response.content else {}
    except ValueError:
        problem = {}
    raise KeelsonError(int(response.status_code), problem if isinstance(problem, dict) else {})


def _retry_after(response: httpx2.Response) -> float | None:
    value = response.headers.get("retry-after")
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        try:
            return max(0.0, parsedate_to_datetime(value).timestamp() - time.time())
        except (TypeError, ValueError):
            return None


def _in_progress(response: httpx2.Response) -> bool:
    if response.status_code != 409:
        return False
    try:
        kind = response.json().get("type", "")
    except ValueError:
        return False
    return isinstance(kind, str) and kind.endswith("/idempotency-in-progress")


def _prepare(request: httpx2.Request) -> None:
    if request.method == "POST" and "idempotency-key" not in request.headers:
        request.headers["idempotency-key"] = str(uuid.uuid4())


class KeelsonTransport(httpx2.BaseTransport):
    """Gives each POST an ``Idempotency-Key``, kept across its retries so Keelson runs it at most
    once, and retries network failures, ``429``, ``5xx`` and an in-progress idempotent request
    with exponential backoff, honoring ``Retry-After``."""

    def __init__(
        self, retry: Retry = DEFAULT_RETRY, inner: httpx2.BaseTransport | None = None
    ) -> None:
        self._retry = retry
        self._inner = inner or httpx2.HTTPTransport()

    def _delay(self, attempt: int, response: httpx2.Response | None) -> float:
        after = _retry_after(response) if response is not None else None
        wait = (
            after if after is not None else random.uniform(0, self._retry.base_delay * 2**attempt)
        )
        return min(self._retry.max_delay, wait)

    def handle_request(self, request: httpx2.Request) -> httpx2.Response:
        _prepare(request)
        for attempt in range(self._retry.max_retries + 1):
            try:
                response = self._inner.handle_request(request)
            except httpx2.TransportError:
                if attempt >= self._retry.max_retries:
                    raise
                time.sleep(self._delay(attempt, None))
                continue
            if attempt >= self._retry.max_retries:
                return response
            if response.status_code not in _RETRYABLE:
                if response.status_code != 409:
                    return response
                response.read()
                if not _in_progress(response):
                    return response
            response.close()
            time.sleep(self._delay(attempt, response))
        raise AssertionError("unreachable")

    def close(self) -> None:
        self._inner.close()


class AsyncKeelsonTransport(httpx2.AsyncBaseTransport):
    """:class:`KeelsonTransport` for ``httpx2.AsyncClient``."""

    def __init__(
        self, retry: Retry = DEFAULT_RETRY, inner: httpx2.AsyncBaseTransport | None = None
    ) -> None:
        self._retry = retry
        self._inner = inner or httpx2.AsyncHTTPTransport()

    def _delay(self, attempt: int, response: httpx2.Response | None) -> float:
        after = _retry_after(response) if response is not None else None
        wait = (
            after if after is not None else random.uniform(0, self._retry.base_delay * 2**attempt)
        )
        return min(self._retry.max_delay, wait)

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        _prepare(request)
        for attempt in range(self._retry.max_retries + 1):
            try:
                response = await self._inner.handle_async_request(request)
            except httpx2.TransportError:
                if attempt >= self._retry.max_retries:
                    raise
                await asyncio.sleep(self._delay(attempt, None))
                continue
            if attempt >= self._retry.max_retries:
                return response
            if response.status_code not in _RETRYABLE:
                if response.status_code != 409:
                    return response
                await response.aread()
                if not _in_progress(response):
                    return response
            await response.aclose()
            await asyncio.sleep(self._delay(attempt, response))
        raise AssertionError("unreachable")

    async def aclose(self) -> None:
        await self._inner.aclose()


def create_client(
    auth: TokenProvider | None = None,
    *,
    base_url: str = KEELSON_API,
    retry: Retry = DEFAULT_RETRY,
    timeout: float = 30.0,
) -> AuthenticatedClient:
    """A client for every generated call, sync and async, against Keelson's API (on the PayPal
    sandbox by default)::

        client = create_client(ClientCredentials(client_id, client_secret, ["countersign:write"]))
        purchase = unwrap(get_purchase.sync_detailed(id=purchase_id, client=client))
    """
    url = httpx2.URL(base_url)
    # A client secret or user token goes to this origin: only over TLS, or to this machine.
    if url.scheme != "https" and url.host not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("base_url must use https")
    bearer = BearerAuth(auth) if auth is not None else None
    # The bearer comes from `auth` on each request, so the generated client holds no token itself.
    client = AuthenticatedClient(base_url=base_url.rstrip("/"), token="")
    client.set_httpx_client(
        httpx2.Client(
            base_url=base_url,
            auth=bearer,
            timeout=timeout,
            transport=KeelsonTransport(retry),
        )
    )
    client.set_async_httpx_client(
        httpx2.AsyncClient(
            base_url=base_url,
            auth=bearer,
            timeout=timeout,
            transport=AsyncKeelsonTransport(retry),
        )
    )
    return client
