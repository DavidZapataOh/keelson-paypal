from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from ._auth import DEFAULT_BASE_URL, AuthProvider, client_credentials, static_token, token_request
from ._errors import APIError, AuthenticationError


@dataclass
class Credentials:
    """What ``keelson login`` saves; the TypeScript SDK reads and writes the same file."""

    apiUrl: str
    clientId: str
    refreshToken: str
    accessToken: str
    expiresAt: int


def credentials_path() -> Path:
    """``$XDG_CONFIG_HOME/keelson/credentials.json``, or ``~/.config/keelson/credentials.json``."""
    if os.environ.get("KEELSON_CREDENTIALS"):
        return Path(os.environ["KEELSON_CREDENTIALS"])
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "keelson" / "credentials.json"


def read_credentials(path: Path | None = None) -> Credentials | None:
    p = path or credentials_path()
    try:
        raw: dict[str, Any] = json.loads(p.read_text())
    except FileNotFoundError:
        return None
    return Credentials(**{k: raw[k] for k in Credentials.__dataclass_fields__})


def write_credentials(credentials: Credentials, path: Path | None = None) -> None:
    """Writes the file readable by its owner only, through a rename so no reader sees half."""
    p = path or credentials_path()
    p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = p.with_name(f"{p.name}.{os.getpid()}.{uuid.uuid4()}.tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(asdict(credentials), indent=2) + "\n")
        os.replace(tmp, p)
    finally:
        tmp.unlink(missing_ok=True)


async def _acquire(lock: Path) -> None:
    """Takes ``<file>.lock``: one process at a time refreshes, since a refresh token is rotated on
    use and a second refresh with the old one would end the sign-in everywhere."""
    lock.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    waited = 0.0
    while True:
        try:
            os.close(os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
            return
        except FileExistsError:
            try:
                stale = time.time() - lock.stat().st_mtime > 30
            except FileNotFoundError:
                stale = False
            if stale or waited > 30:
                lock.unlink(missing_ok=True)
            await asyncio.sleep(0.05)
            waited += 0.05


# One refresh per credentials file in this process at a time.
_refreshing: dict[Path, asyncio.Future[str]] = {}


_RELOGIN = "Your Keelson sign-in has ended. Run `keelson login` again."


def _no_credentials() -> AuthenticationError:
    return AuthenticationError(
        401,
        {
            "error": "no_credentials",
            "error_description": "No Keelson credentials. Run `keelson login`.",
        },
        None,
    )


class _StoredLogin:
    def __init__(self, path: Path | None, base_url: str | None = None) -> None:
        self._path = path or credentials_path()
        self._base_url = base_url
        self._handed_out: str | None = None

    async def token(self, *, force: bool = False) -> str:
        c = read_credentials(self._path)
        if c is None:
            raise _no_credentials()
        fresh = time.time() * 1000 < c.expiresAt - 30_000
        if fresh and (not force or c.accessToken != self._handed_out):
            self._handed_out = c.accessToken
            return c.accessToken
        shared = _refreshing.get(self._path)
        if shared is not None:
            self._handed_out = await asyncio.shield(shared)
            return self._handed_out
        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        _refreshing[self._path] = future
        try:
            token = await self._refresh(c.accessToken)
            future.set_result(token)
        except BaseException as err:
            future.set_exception(err)
            future.exception()  # retrieved here, raised to every waiter
            raise
        finally:
            del _refreshing[self._path]
        self._handed_out = token
        return token

    async def _refresh(self, stale: str) -> str:
        lock = self._path.with_name(f"{self._path.name}.lock")
        await _acquire(lock)
        try:
            c = read_credentials(self._path)
            if c is None:
                raise _no_credentials()
            # Another process may have refreshed while this one waited for the lock.
            if c.accessToken != stale and time.time() * 1000 < c.expiresAt - 30_000:
                return c.accessToken
            try:
                # The client's API, which the token is for, not whichever one the file names.
                t = await token_request(
                    self._base_url or c.apiUrl,
                    {"grant_type": "refresh_token", "refresh_token": c.refreshToken, "client_id": c.clientId},
                )
            except APIError as err:
                if err.type == "invalid_grant":
                    raise AuthenticationError(
                        401, {"error": "invalid_grant", "error_description": _RELOGIN}, err.request_id
                    ) from err
                raise
            c.accessToken = t["access_token"]
            c.refreshToken = t.get("refresh_token") or c.refreshToken
            c.expiresAt = int(time.time() * 1000 + t["expires_in"] * 1000)
            write_credentials(c, self._path)
            return c.accessToken
        finally:
            lock.unlink(missing_ok=True)


def stored_login(path: Path | str | None = None, *, base_url: str | None = None) -> AuthProvider:
    """The user's sign-in that ``keelson login`` saved, refreshed as needed against ``base_url``."""
    return _StoredLogin(Path(path) if path else None, base_url)


def resolve_auth(base_url: str = DEFAULT_BASE_URL) -> AuthProvider:
    """``KEELSON_CLIENT_ID`` and ``KEELSON_CLIENT_SECRET``, then ``KEELSON_TOKEN``, then the saved sign-in."""
    cid, secret = os.environ.get("KEELSON_CLIENT_ID"), os.environ.get("KEELSON_CLIENT_SECRET")
    if cid and secret:
        return client_credentials(cid, secret, base_url=base_url)
    if os.environ.get("KEELSON_TOKEN"):
        return static_token(os.environ["KEELSON_TOKEN"])
    return stored_login(base_url=base_url)
