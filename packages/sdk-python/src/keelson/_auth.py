from __future__ import annotations

import base64
import time
from typing import Any, Protocol
from urllib.parse import quote

import httpx2

from ._errors import error_for

AUDIENCE = "https://api.keelson.finance"
DEFAULT_BASE_URL = "https://api.keelson.finance"
OPERATOR_SCOPES = ("countersign:write", "evidence:write", "alibis:read")


class AuthProvider(Protocol):
    """Something that hands out a bearer token for Keelson's API."""

    async def token(self, *, force: bool = False) -> str:
        """A valid access token; ``force`` asks for a new one after the API refused the last."""
        ...


async def token_request(base_url: str, form: dict[str, str], headers: dict[str, str] | None = None) -> dict[str, Any]:
    async with httpx2.AsyncClient(timeout=30.0) as client:
        res = await client.post(
            f"{base_url}/api/auth/oauth2/token",
            data={"resource": AUDIENCE, **form},
            headers=headers or {},
        )
    try:
        body: dict[str, Any] = res.json()
    except ValueError:
        body = {}
    if res.status_code >= 400:
        raise error_for(res.status_code, body, res.headers.get("x-request-id"))
    return body


class _ClientCredentials:
    def __init__(self, client_id: str, client_secret: str, scopes: tuple[str, ...], base_url: str) -> None:
        pair = f"{quote(client_id, safe='')}:{quote(client_secret, safe='')}"
        self._basic = base64.b64encode(pair.encode()).decode()
        self._scopes = scopes
        self._base_url = base_url
        self._cached: tuple[str, float] | None = None

    async def token(self, *, force: bool = False) -> str:
        if self._cached and not force and time.time() < self._cached[1]:
            return self._cached[0]
        t = await token_request(
            self._base_url,
            {"grant_type": "client_credentials", "scope": " ".join(self._scopes)},
            {"authorization": f"Basic {self._basic}"},
        )
        self._cached = (t["access_token"], time.time() + t["expires_in"] - 30)
        return self._cached[0]


def client_credentials(
    client_id: str,
    client_secret: str,
    *,
    scopes: tuple[str, ...] = OPERATOR_SCOPES,
    base_url: str = DEFAULT_BASE_URL,
) -> AuthProvider:
    """An operator's agent, with its OAuth client (RFC 6749 §4.4)."""
    return _ClientCredentials(client_id, client_secret, scopes, base_url)


class _Static:
    def __init__(self, value: str) -> None:
        self._value = value

    async def token(self, *, force: bool = False) -> str:
        return self._value


def static_token(token: str) -> AuthProvider:
    """A token you already hold."""
    return _Static(token)
