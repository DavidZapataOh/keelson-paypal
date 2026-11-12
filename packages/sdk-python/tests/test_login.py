from __future__ import annotations

from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx2

from keelson import login, read_credentials

from .conftest import Scripted, json_reply


async def test_a_stray_callback_with_the_wrong_state_does_not_end_the_sign_in(server: Scripted, tmp_path: Path) -> None:
    server.script(
        json_reply(201, {"client_id": "cli"}),
        json_reply(200, {"access_token": "a1", "refresh_token": "r1", "expires_in": 3600}),
    )
    path = tmp_path / "credentials.json"

    def open_browser(url: str) -> None:
        q = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
        stray = httpx2.get(f"{q['redirect_uri']}?code=evil&state=guess")
        assert stray.status_code == 400
        httpx2.get(f"{q['redirect_uri']}?code=good&state={q['state']}")

    c = await login(base_url=server.url, path=path, open=open_browser, timeout=10)
    assert c.accessToken == "a1"
    assert parse_qs(server.seen[1]["body"])["code"] == ["good"]
    saved = read_credentials(path)
    assert saved is not None and saved.clientId == "cli"
