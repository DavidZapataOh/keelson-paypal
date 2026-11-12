from __future__ import annotations

import asyncio
import inspect
import os
import threading
from collections.abc import AsyncIterator, Callable, Iterator
from typing import Any

import httpx2

from ._agent_key import import_agent_key
from ._auth import DEFAULT_BASE_URL, AuthProvider
from ._credentials import resolve_auth
from ._errors import KeelsonError
from ._transport import Transport, check_base_url, send
from .resources.alibis import Alibis
from .resources.events import Events
from .resources.evidence import Evidence
from .resources.mandates import Mandates
from .resources.operators import Operators
from .resources.purchases import Purchases
from .resources.requests import Requests

_UNSET: Any = object()


class AsyncKeelson:
    """Keelson's API, for asyncio."""

    def __init__(
        self,
        auth: AuthProvider | None = _UNSET,
        *,
        base_url: str | None = None,
        max_retries: int = 2,
        timeout: float = 60.0,
        agent_key: dict[str, Any] | str | None = None,
    ) -> None:
        """``auth`` left out reads ``KEELSON_CLIENT_ID`` and ``KEELSON_CLIENT_SECRET``, then
        ``KEELSON_TOKEN``, then the sign-in ``keelson login`` saved; ``None`` calls only public
        operations. ``agent_key`` (or ``KEELSON_AGENT_KEY``) is an operator's private P-256 JWK.
        """
        self.base_url = check_base_url(base_url or os.environ.get("KEELSON_API_URL") or DEFAULT_BASE_URL)
        provider: list[AuthProvider] = [] if auth is _UNSET or auth is None else [auth]

        def get_auth() -> AuthProvider:
            if auth is None:
                raise KeelsonError("This client has no credentials; pass `auth`.")
            if not provider:
                provider.append(resolve_auth(self.base_url))
            return provider[0]

        self._transport = Transport(self.base_url, max_retries, timeout, get_auth, httpx2.AsyncClient())
        raw = agent_key if agent_key is not None else os.environ.get("KEELSON_AGENT_KEY")
        self._key: Any = None
        self._raw_key = raw
        self.mandates = Mandates(self)
        self.requests = Requests(self)
        self.evidence = Evidence(self)
        self.purchases = Purchases(self)
        self.alibis = Alibis(self)
        self.events = Events(self)
        self.operators = Operators(self)

    def _agent_key(self) -> Any:
        if self._raw_key is not None and self._key is None:
            self._key = import_agent_key(self._raw_key)
        return self._key

    async def request(self, method: str, path: str, **kwargs: Any) -> Any:
        """Calls any operation of the API and returns its JSON."""
        return (await send(self._transport, method, path, **kwargs)).data

    async def status(self) -> dict[str, Any]:
        """Whether Keelson and each dependency is up, and on which environment."""
        data: dict[str, Any] = (await send(self._transport, "GET", "/status", auth=False)).data
        return data

    async def aclose(self) -> None:
        await self._transport.client.aclose()


class _Loop:
    """One event loop on a daemon thread that runs the async client for the blocking one."""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True, name="keelson").start()

    def stop(self) -> None:
        self.loop.call_soon_threadsafe(self.loop.stop)

    def run(self, coro: Any) -> Any:
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result()

    def iterate(self, agen: AsyncIterator[Any]) -> Iterator[Any]:
        while True:
            try:
                yield self.run(agen.__anext__())
            except StopAsyncIteration:
                return


class _Blocking:
    def __init__(self, target: Any, loop: _Loop) -> None:
        self._target = target
        self._loop = loop

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._target, name)
        if inspect.isasyncgenfunction(attr):
            return lambda *a, **k: self._loop.iterate(attr(*a, **k))
        if inspect.iscoroutinefunction(attr):
            fn: Callable[..., Any] = attr
            return lambda *a, **k: self._loop.run(fn(*a, **k))
        return attr


class Keelson:
    """Keelson's API, blocking. Every method of :class:`AsyncKeelson`, without ``await``."""

    def __init__(self, auth: AuthProvider | None = _UNSET, **kwargs: Any) -> None:
        self._loop = _Loop()
        self._async: AsyncKeelson = self._loop.run(self._make(auth, kwargs))
        self.base_url = self._async.base_url
        self.mandates: Any = _Blocking(self._async.mandates, self._loop)
        self.requests: Any = _Blocking(self._async.requests, self._loop)
        self.evidence: Any = _Blocking(self._async.evidence, self._loop)
        self.purchases: Any = _Blocking(self._async.purchases, self._loop)
        self.alibis: Any = _Blocking(self._async.alibis, self._loop)
        self.events: Any = _Blocking(self._async.events, self._loop)
        self.operators: Any = _Blocking(self._async.operators, self._loop)

    @staticmethod
    async def _make(auth: AuthProvider | None, kwargs: dict[str, Any]) -> AsyncKeelson:
        return AsyncKeelson(auth, **kwargs)

    def request(self, method: str, path: str, **kwargs: Any) -> Any:
        return self._loop.run(self._async.request(method, path, **kwargs))

    def status(self) -> dict[str, Any]:
        result: dict[str, Any] = self._loop.run(self._async.status())
        return result

    def close(self) -> None:
        self._loop.run(self._async.aclose())
        self._loop.stop()
