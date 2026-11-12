from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

import keelson
from keelson import AsyncKeelson, client_credentials, login, static_token, stored_login

from .conftest import act, live

pytestmark = [pytest.mark.live, live]


async def test_status_names_each_dependency_and_its_environment() -> None:
    status = await AsyncKeelson(None).status()
    assert status["status"] in ("ok", "degraded")
    assert status["dependencies"]["paypal"]["environment"] == "sandbox"
    assert status["dependencies"]["anchor"]["environment"] == "arbitrum-sepolia"


async def test_a_bad_token_is_an_authentication_error_with_a_request_id() -> None:
    with pytest.raises(keelson.AuthenticationError) as err:
        await AsyncKeelson(static_token("not-a-token"), max_retries=0).request(
            "GET", "/v1/purchases/01JX0000000000000000000000"
        )
    assert err.value.request_id and len(err.value.request_id) == 26


async def test_a_wrong_client_secret_is_invalid_client() -> None:
    with pytest.raises(keelson.AuthenticationError) as err:
        await client_credentials("nobody", "wrong").token()
    assert err.value.type == "invalid_client"


async def test_signs_in_through_the_loopback_flow(tmp_path: Path) -> None:
    path = tmp_path / "credentials.json"
    c = await login(path=path, open=lambda url: act("login", url))
    part = c.accessToken.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    assert sorted(claims["scope"].split()) == sorted(keelson.LOGIN_SCOPES)
    with pytest.raises(keelson.NotFoundError):
        await AsyncKeelson(stored_login(path)).request("GET", "/v1/connections/requests/01JX0000000000000000000000")
