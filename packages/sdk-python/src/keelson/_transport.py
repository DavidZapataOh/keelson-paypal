from __future__ import annotations

import asyncio
import email.utils
import json
import random
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx2

from ._auth import AuthProvider
from ._errors import (
    APIConnectionError,
    APIConnectionTimeoutError,
    APIError,
    AuthenticationError,
    KeelsonError,
    OutcomeUnknownError,
    error_for,
)

_LOOPBACK = {"localhost", "127.0.0.1", "[::1]", "::1"}
_COUNTERSIGN = "/v1/countersign"


def check_base_url(raw: str) -> str:
    """Refuses to send a token anywhere but over TLS or to this machine."""
    url = urlsplit(raw)
    if url.scheme != "https" and not (url.scheme == "http" and url.hostname in _LOOPBACK):
        raise KeelsonError(f"base_url must use https: {raw}")
    return f"{url.scheme}://{url.netloc}"


@dataclass
class APIResponse:
    data: Any
    response: httpx2.Response
    request_id: str | None


@dataclass
class Transport:
    base_url: str
    max_retries: int
    timeout: float
    auth: Callable[[], AuthProvider]
    client: httpx2.AsyncClient = field(default_factory=lambda: httpx2.AsyncClient())


def _delay(attempt: int, response: httpx2.Response | None = None) -> float:
    header: str | None = response.headers.get("retry-after") if response is not None else None
    if header:
        try:
            seconds = float(header)
        except ValueError:
            parsed = email.utils.parsedate_to_datetime(header)
            seconds = float(parsed.timestamp()) - time.time()
        if 0 <= seconds <= 60:
            return seconds
    backoff: float = min(0.5 * 2.0**attempt, 8.0)
    return backoff * (1 - 0.25 * random.random())


def _retryable(status: int, type_: str | None) -> bool:
    return status in (408, 429) or status >= 500 or (status == 409 and type_ == "idempotency-in-progress")


def _lost(method: str, path: str, body: Any, err: KeelsonError) -> KeelsonError:
    request_id = body.get("requestId") if isinstance(body, dict) else None
    if method == "POST" and path == _COUNTERSIGN and isinstance(request_id, str):
        lost = OutcomeUnknownError(request_id)
        lost.__cause__ = err
        return lost
    return err


async def send(
    t: Transport,
    method: str,
    path: str,
    *,
    body: Any = None,
    query: dict[str, str | int | None] | None = None,
    idempotency_key: str | None = None,
    headers: dict[str, str] | None = None,
    auth: bool | Literal["optional"] = True,
    as_: Literal["json", "bytes", "none", "stream"] = "json",
) -> APIResponse:
    """One call to Keelson's API: auth, idempotency, retries, a timeout per attempt, typed errors."""
    h = dict(headers or {})
    h["accept"] = "*/*" if as_ == "bytes" else "text/event-stream" if as_ == "stream" else "application/json"
    content: bytes | None = None
    if isinstance(body, bytes | bytearray):
        content = bytes(body)
    elif body is not None:
        content = json.dumps(body, separators=(",", ":")).encode()
        h["content-type"] = "application/json"
    if method == "POST":
        h["idempotency-key"] = idempotency_key or str(uuid.uuid4())
    params = {k: str(v) for k, v in (query or {}).items() if v is not None}
    provider: AuthProvider | None = None
    if auth == "optional":
        try:
            provider = t.auth()
        except KeelsonError:
            provider = None
    elif auth:
        provider = t.auth()
    refreshed = False
    force = False
    attempt = 0
    while True:
        if provider is not None:
            h["authorization"] = f"Bearer {await provider.token(force=force)}"
        force = False
        try:
            request = t.client.build_request(
                method,
                f"{t.base_url}{path}",
                content=content,
                params=params,
                headers=h,
                timeout=t.timeout,
            )
            response = await t.client.send(request, stream=as_ == "stream")
        except httpx2.TimeoutException as cause:
            err: KeelsonError = APIConnectionTimeoutError(f"No answer from {t.base_url} in {t.timeout} s")
            err.__cause__ = cause
        except httpx2.TransportError as cause:
            err = APIConnectionError(f"Could not reach {t.base_url}")
            err.__cause__ = cause
        else:
            request_id = response.headers.get("x-request-id")
            if response.is_success:
                if as_ == "stream":
                    return APIResponse(None, response, request_id)
                data: Any = (
                    response.content
                    if as_ == "bytes"
                    else None
                    if as_ == "none" or response.status_code == 204
                    else response.json()
                )
                return APIResponse(data, response, request_id)
            if as_ == "stream":
                await response.aread()
            try:
                problem = response.json()
            except ValueError:
                problem = {}
            api_err = error_for(response.status_code, problem if isinstance(problem, dict) else {}, request_id)
            if (
                isinstance(api_err, AuthenticationError)
                and provider is not None
                and not refreshed
                and "invalid_token" in response.headers.get("www-authenticate", "")
            ):
                refreshed = True
                force = True
                continue
            if _retryable(response.status_code, api_err.type) and attempt < t.max_retries:
                await asyncio.sleep(_delay(attempt, response))
                attempt += 1
                continue
            lost = response.status_code >= 500 or api_err.type == "idempotency-in-progress"
            raise _lost(method, path, body, api_err) if lost else api_err
        if attempt < t.max_retries:
            await asyncio.sleep(_delay(attempt))
            attempt += 1
            continue
        raise _lost(method, path, body, err)


__all__ = ["APIError", "APIResponse", "Transport", "check_base_url", "send"]
