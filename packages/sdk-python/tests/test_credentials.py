from __future__ import annotations

import json
import os
import stat
import time
from pathlib import Path
from urllib.parse import parse_qs

import pytest

import keelson
from keelson import Credentials, stored_login, write_credentials

from .conftest import Scripted, json_reply


def saved(server: Scripted, **over: object) -> Credentials:
    base = {
        "apiUrl": server.url,
        "clientId": "cli",
        "refreshToken": "r0",
        "accessToken": "a0",
        "expiresAt": int(time.time() * 1000) + 3_600_000,
    }
    return Credentials(**{**base, **over})  # type: ignore[arg-type]


def test_the_file_is_written_for_its_owner_only_through_a_rename(server: Scripted, tmp_path: Path) -> None:
    path = tmp_path / "a" / "credentials.json"
    write_credentials(saved(server), path)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert os.listdir(tmp_path / "a") == ["credentials.json"]


async def test_an_expired_token_is_refreshed_once_and_a_second_reader_uses_it(server: Scripted, tmp_path: Path) -> None:
    path = tmp_path / "b.json"
    write_credentials(saved(server, expiresAt=0), path)
    server.script(json_reply(200, {"access_token": "a1", "refresh_token": "r1", "expires_in": 3600}))
    assert await stored_login(path).token() == "a1"
    assert await stored_login(path).token() == "a1"
    assert len(server.seen) == 1
    form = {k: v[0] for k, v in parse_qs(server.seen[0]["body"]).items()}
    assert form == {
        "resource": "https://api.keelson.finance",
        "grant_type": "refresh_token",
        "refresh_token": "r0",
        "client_id": "cli",
    }
    assert json.loads(path.read_text())["refreshToken"] == "r1"


async def test_a_token_another_process_refreshed_is_used(server: Scripted, tmp_path: Path) -> None:
    path = tmp_path / "c.json"
    write_credentials(saved(server, accessToken="old"), path)
    mine = stored_login(path)
    assert await mine.token() == "old"
    write_credentials(saved(server, accessToken="new"), path)
    server.script()
    assert await mine.token(force=True) == "new"
    assert server.seen == []


async def test_a_revoked_sign_in_names_keelson_login(server: Scripted, tmp_path: Path) -> None:
    path = tmp_path / "d.json"
    write_credentials(saved(server, expiresAt=0), path)
    server.script(json_reply(400, {"error": "invalid_grant", "error_description": "revoked"}))
    with pytest.raises(keelson.AuthenticationError) as err:
        await stored_login(path).token()
    assert err.value.type == "invalid_grant" and "keelson login" in str(err.value)
    assert len(server.seen) == 1


async def test_reads_the_file_the_typescript_cli_writes(server: Scripted, tmp_path: Path) -> None:
    path = tmp_path / "ts.json"
    ts = {"apiUrl": server.url, "clientId": "c", "refreshToken": "r", "accessToken": "a", "expiresAt": 9e12}
    path.write_text(json.dumps(ts, indent=2) + "\n")
    assert await stored_login(path).token() == "a"


async def test_two_refreshes_at_once_send_one_request(server: Scripted, tmp_path: Path) -> None:
    import asyncio

    path = tmp_path / "e.json"
    write_credentials(saved(server, expiresAt=0), path)

    def slow(h: object) -> None:
        time.sleep(0.2)
        json_reply(200, {"access_token": "a9", "refresh_token": "r9", "expires_in": 3600})(h)  # type: ignore[arg-type]

    server.script(slow)
    one = stored_login(path)
    tokens = await asyncio.gather(one.token(), one.token(), stored_login(path).token())
    assert tokens == ["a9", "a9", "a9"]
    assert len(server.seen) == 1
    assert not (tmp_path / "e.json.lock").exists()


async def test_a_refresh_goes_to_the_clients_api_not_the_files(server: Scripted, tmp_path: Path) -> None:
    path = tmp_path / "f.json"
    write_credentials(saved(server, apiUrl="https://elsewhere.invalid", expiresAt=0), path)
    server.script(json_reply(200, {"access_token": "a2", "expires_in": 3600}))
    assert await stored_login(path, base_url=server.url).token() == "a2"
    assert len(server.seen) == 1
