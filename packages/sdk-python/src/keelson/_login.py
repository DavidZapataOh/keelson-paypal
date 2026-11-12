from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import secrets
import socket
import sys
import time
import webbrowser
from collections.abc import Awaitable, Callable
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx2

from ._auth import AUDIENCE, DEFAULT_BASE_URL, token_request
from ._credentials import Credentials, credentials_path, read_credentials, write_credentials
from ._errors import KeelsonError, error_for
from ._transport import check_base_url

LOGIN_SCOPES = (
    "mandates:request",
    "evidence:write",
    "purchases:write",
    "alibis:read",
    "offline_access",
)
_REDIRECT = "http://127.0.0.1/callback"


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


async def _register(base_url: str, scopes: tuple[str, ...]) -> str:
    async with httpx2.AsyncClient(timeout=30.0) as client:
        res = await client.post(
            f"{base_url}/api/auth/oauth2/register",
            json={
                "client_name": f"Keelson CLI on {socket.gethostname()}"[:64],
                "redirect_uris": [_REDIRECT],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "scope": " ".join(scopes),
            },
        )
    body: dict[str, Any] = res.json() if res.content else {}
    if res.status_code >= 400:
        raise error_for(res.status_code, body, res.headers.get("x-request-id"))
    return str(body["client_id"])


async def login(
    *,
    base_url: str | None = None,
    open: Callable[[str], Awaitable[None] | None] | None = None,
    scopes: tuple[str, ...] = LOGIN_SCOPES,
    path: Path | str | None = None,
    timeout: float = 600.0,
) -> Credentials:
    """Signs the developer in from the terminal: OAuth 2.1 with PKCE through the system browser
    and a one-time listener on 127.0.0.1 (RFC 8252), then saves the sign-in."""
    base = check_base_url(base_url or os.environ.get("KEELSON_API_URL") or DEFAULT_BASE_URL)
    p = Path(path) if path else credentials_path()
    saved = read_credentials(p)
    client_id = saved.clientId if saved and saved.apiUrl == base else await _register(base, scopes)
    verifier = _b64url(secrets.token_bytes(32))
    state = _b64url(secrets.token_bytes(16))
    result: dict[str, str] = {}
    done = asyncio.Event()
    loop = asyncio.get_running_loop()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            url = urlsplit(self.path)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            ok = url.path == "/callback" and "code" in q and q.get("state") == state
            self.send_response(200 if ok else 400)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.end_headers()
            text = "Signed in. You can close this tab." if ok else "Sign-in failed. Run keelson login again."
            self.wfile.write(f'<!doctype html><p style="font:16px system-ui;margin:3rem">{text}</p>'.encode())
            # Only an answer carrying this sign-in's state counts; anything else on this machine
            # that hits the listener is turned away and the sign-in keeps waiting.
            if url.path == "/callback" and q.get("state") == state:
                result.update(q if ok else {"error": q.get("error", "no code")})
                loop.call_soon_threadsafe(done.set)

        def log_message(self, *args: Any) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    Thread(target=server.serve_forever, daemon=True).start()
    redirect = f"http://127.0.0.1:{server.server_address[1]}/callback"
    try:
        url = f"{base}/api/auth/oauth2/authorize?" + urlencode(
            {
                "response_type": "code",
                "client_id": client_id,
                "redirect_uri": redirect,
                "scope": " ".join(scopes),
                "state": state,
                "code_challenge": _b64url(hashlib.sha256(verifier.encode()).digest()),
                "code_challenge_method": "S256",
                "resource": AUDIENCE,
            }
        )
        print(f"Sign in to Keelson in your browser:\n  {url}", file=sys.stderr)
        opened = (open or webbrowser.open)(url)
        if asyncio.iscoroutine(opened):
            await opened
        await asyncio.wait_for(done.wait(), timeout)
        if "error" in result:
            raise KeelsonError(f"Sign-in failed: {result['error']}")
        t = await token_request(
            base,
            {
                "grant_type": "authorization_code",
                "code": result["code"],
                "redirect_uri": redirect,
                "client_id": client_id,
                "code_verifier": verifier,
            },
        )
    finally:
        server.shutdown()
    if not t.get("refresh_token"):
        raise KeelsonError("The sign-in returned no refresh token.")
    c = Credentials(
        base,
        client_id,
        t["refresh_token"],
        t["access_token"],
        int(time.time() * 1000 + t["expires_in"] * 1000),
    )
    write_credentials(c, p)
    print(f"Signed in. Saved to {p}", file=sys.stderr)
    return c
