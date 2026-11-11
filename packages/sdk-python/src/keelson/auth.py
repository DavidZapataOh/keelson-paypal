"""OAuth 2.1 for Keelson's API: client credentials for an operator's agent, the authorization code
grant with PKCE for an app acting for a user, and the bearer that carries either."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import secrets
import threading
import time
from collections.abc import AsyncGenerator, Callable, Generator, Sequence
from dataclasses import dataclass, replace
from typing import Protocol
from urllib.parse import quote, urlencode

import httpx2

KEELSON_API = "https://api.keelson.finance"
"""Keelson's API: the resource (RFC 8707) every access token is requested for."""

DELEGATED_SCOPES = (
    "mandates:request",
    "evidence:write",
    "purchases:write",
    "alibis:read",
    "offline_access",
)
"""The scopes an app acting for a user may hold."""

_EARLY = 60.0
"""Refresh this many seconds before a token expires."""


class OAuthError(Exception):
    """An OAuth error the authorization server answered (RFC 6749 §5.2)."""

    def __init__(self, status: int, error: str, description: str | None = None) -> None:
        super().__init__(f"{error}: {description}" if description else error)
        self.status = status
        self.error = error
        self.description = description


@dataclass(frozen=True)
class TokenSet:
    """The tokens an authorization server answered (RFC 6749 §5.1)."""

    access_token: str
    expires_at: float
    """Seconds since the epoch."""
    refresh_token: str | None = None
    scope: str | None = None


class TokenProvider(Protocol):
    """Supplies the bearer token of each request."""

    def token(self) -> str: ...

    async def atoken(self) -> str: ...

    def invalidate(self) -> None:
        """Drops the cached token after the API refused it."""


def _auth_server(base_url: str) -> str:
    return f"{base_url.rstrip('/')}/api/auth"


def _token_set(response: httpx2.Response) -> TokenSet:
    try:
        body = response.json()
    except ValueError:
        body = {}
    if not response.is_success or not isinstance(body.get("access_token"), str):
        raise OAuthError(
            response.status_code,
            body.get("error") or f"http_{response.status_code}",
            body.get("error_description"),
        )
    return TokenSet(
        access_token=body["access_token"],
        expires_at=time.time() + float(body.get("expires_in", 3600)),
        refresh_token=body.get("refresh_token"),
        scope=body.get("scope"),
    )


class _Cached:
    """A token kept until a minute before it expires, fetched once for concurrent callers."""

    def __init__(self) -> None:
        self._current: TokenSet | None = None
        self._lock = threading.Lock()
        self._alock = asyncio.Lock()

    def _fresh(self) -> str | None:
        current = self._current
        if current and time.time() < current.expires_at - _EARLY:
            return current.access_token
        return None

    def _request(self) -> tuple[str, dict[str, str], dict[str, str]]:
        raise NotImplementedError

    def _accept(self, tokens: TokenSet) -> TokenSet:
        return tokens

    def token(self) -> str:
        with self._lock:
            if (fresh := self._fresh()) is not None:
                return fresh
            url, data, headers = self._request()
            self._current = self._accept(_token_set(httpx2.post(url, data=data, headers=headers)))
            return self._current.access_token

    async def atoken(self) -> str:
        async with self._alock:
            if (fresh := self._fresh()) is not None:
                return fresh
            url, data, headers = self._request()
            async with httpx2.AsyncClient() as client:
                response = await client.post(url, data=data, headers=headers)
            self._current = self._accept(_token_set(response))
            return self._current.access_token

    def invalidate(self) -> None:
        self._current = None


class ClientCredentials(_Cached):
    """An operator's agent acting for itself: the client credentials grant (RFC 6749 §4.4) with
    ``client_secret_basic``, for Keelson's API as the resource."""

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        scopes: Sequence[str],
        *,
        base_url: str = KEELSON_API,
    ) -> None:
        super().__init__()
        self._client_id = client_id
        self._client_secret = client_secret
        self._scopes = " ".join(scopes)
        self._base_url = base_url

    def _request(self) -> tuple[str, dict[str, str], dict[str, str]]:
        basic = base64.b64encode(
            f"{quote(self._client_id, safe='')}:{quote(self._client_secret, safe='')}".encode()
        ).decode()
        return (
            f"{_auth_server(self._base_url)}/oauth2/token",
            {"grant_type": "client_credentials", "scope": self._scopes, "resource": KEELSON_API},
            {"authorization": f"Basic {basic}"},
        )


class UserTokens(_Cached):
    """The tokens a user granted an app, refreshed with the refresh token as they expire.

    ``on_tokens`` receives every new set so the app can store it. After the user stops every
    agent, the refresh token is revoked and ``token()`` raises ``OAuthError("invalid_grant")``:
    ask the user to sign in again.
    """

    def __init__(
        self,
        client_id: str,
        tokens: TokenSet,
        *,
        on_tokens: Callable[[TokenSet], None] | None = None,
        base_url: str = KEELSON_API,
    ) -> None:
        super().__init__()
        self._client_id = client_id
        self._current = tokens
        self._refresh_token = tokens.refresh_token
        self._on_tokens = on_tokens
        self._base_url = base_url

    def _request(self) -> tuple[str, dict[str, str], dict[str, str]]:
        if not self._refresh_token:
            raise OAuthError(401, "invalid_grant", "no refresh token")
        return (
            f"{_auth_server(self._base_url)}/oauth2/token",
            {
                "grant_type": "refresh_token",
                "client_id": self._client_id,
                "refresh_token": self._refresh_token,
                "resource": KEELSON_API,
            },
            {},
        )

    def _accept(self, tokens: TokenSet) -> TokenSet:
        if tokens.refresh_token is None:
            tokens = replace(tokens, refresh_token=self._refresh_token)
        self._refresh_token = tokens.refresh_token
        if self._on_tokens:
            self._on_tokens(tokens)
        return tokens


class StaticToken:
    """A token obtained elsewhere, sent as is."""

    def __init__(self, token: str) -> None:
        self._token = token

    def token(self) -> str:
        return self._token

    async def atoken(self) -> str:
        return self._token

    def invalidate(self) -> None:
        pass


def register_public_client(
    client_name: str,
    redirect_uris: Sequence[str],
    *,
    scopes: Sequence[str] = DELEGATED_SCOPES,
    base_url: str = KEELSON_API,
) -> str:
    """Registers an app as a public client (RFC 7591, ``token_endpoint_auth_method: none``), as
    MCP hosts do. Returns its ``client_id``."""
    response = httpx2.post(
        f"{_auth_server(base_url)}/oauth2/register",
        json={
            "client_name": client_name,
            "redirect_uris": list(redirect_uris),
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "scope": " ".join(scopes),
        },
    )
    body = response.json() if response.content else {}
    if not response.is_success or not isinstance(body.get("client_id"), str):
        raise OAuthError(
            response.status_code,
            body.get("error") or f"http_{response.status_code}",
            body.get("error_description"),
        )
    return str(body["client_id"])


@dataclass(frozen=True)
class AuthorizationRequest:
    url: str
    """Send the user here; Keelson redirects back to ``redirect_uri`` with ``code`` and ``state``."""
    code_verifier: str
    """Keep it for :func:`exchange_code`; never send it anywhere else."""
    state: str


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def create_authorization_request(
    client_id: str,
    redirect_uri: str,
    *,
    scopes: Sequence[str] = DELEGATED_SCOPES,
    base_url: str = KEELSON_API,
) -> AuthorizationRequest:
    """Starts the authorization code grant with PKCE (RFC 7636, S256) for an app acting for a
    user, with Keelson's API as the resource (RFC 8707)."""
    verifier = _b64url(secrets.token_bytes(32))
    state = _b64url(secrets.token_bytes(16))
    query = urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "scope": " ".join(scopes),
            "state": state,
            "code_challenge": _b64url(hashlib.sha256(verifier.encode()).digest()),
            "code_challenge_method": "S256",
            "resource": KEELSON_API,
        }
    )
    return AuthorizationRequest(
        url=f"{_auth_server(base_url)}/oauth2/authorize?{query}",
        code_verifier=verifier,
        state=state,
    )


def exchange_code(
    client_id: str,
    code: str,
    code_verifier: str,
    redirect_uri: str,
    *,
    base_url: str = KEELSON_API,
) -> TokenSet:
    """Redeems the authorization code the redirect carried for tokens."""
    return _token_set(
        httpx2.post(
            f"{_auth_server(base_url)}/oauth2/token",
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code,
                "code_verifier": code_verifier,
                "redirect_uri": redirect_uri,
                "resource": KEELSON_API,
            },
        )
    )


class BearerAuth(httpx2.Auth):
    """Sends the provider's token; a ``401 invalid_token`` gets one fresh token."""

    def __init__(self, provider: TokenProvider) -> None:
        self._provider = provider

    @staticmethod
    def _refused(response: httpx2.Response) -> bool:
        return response.status_code == 401 and "invalid_token" in response.headers.get(
            "www-authenticate", ""
        )

    def sync_auth_flow(
        self, request: httpx2.Request
    ) -> Generator[httpx2.Request, httpx2.Response, None]:
        request.headers["authorization"] = f"Bearer {self._provider.token()}"
        response = yield request
        if self._refused(response):
            self._provider.invalidate()
            request.headers["authorization"] = f"Bearer {self._provider.token()}"
            yield request

    async def async_auth_flow(
        self, request: httpx2.Request
    ) -> AsyncGenerator[httpx2.Request, httpx2.Response]:
        request.headers["authorization"] = f"Bearer {await self._provider.atoken()}"
        response = yield request
        if self._refused(response):
            self._provider.invalidate()
            request.headers["authorization"] = f"Bearer {await self._provider.atoken()}"
            yield request
