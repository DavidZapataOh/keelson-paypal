from __future__ import annotations

import re
import time

import pytest

import keelson
from keelson import AsyncKeelson, Keelson, static_token

from .conftest import Scripted, drop, json_reply, problem

KEY = re.compile(r"^[\w-]{1,255}$")


def client(server: Scripted, **kw: object) -> AsyncKeelson:
    return AsyncKeelson(static_token("t0"), base_url=server.url, timeout=2.0, **kw)  # type: ignore[arg-type]


async def post(k: AsyncKeelson, **kw: object) -> object:
    return await k.request("POST", "/v1/evidence", body={"a": 1}, **kw)


async def test_one_idempotency_key_is_kept_across_503_502_then_201(server: Scripted) -> None:
    server.script(problem(503, "unavailable"), problem(502, "bad-gateway"), json_reply(201, {"ok": True}))
    assert await post(client(server)) == {"ok": True}
    keys = {r["headers"]["idempotency-key"] for r in server.seen}
    assert len(server.seen) == 3 and len(keys) == 1 and KEY.match(keys.pop())


async def test_a_post_carries_a_key_even_with_max_retries_0(server: Scripted) -> None:
    server.script(json_reply(201, {}))
    await post(client(server, max_retries=0))
    assert KEY.match(server.seen[0]["headers"]["idempotency-key"])


async def test_a_callers_key_is_kept_and_a_get_sends_none(server: Scripted) -> None:
    server.script(json_reply(201, {}), json_reply(200, {}))
    k = client(server)
    await post(k, idempotency_key="my-key")
    await k.request("GET", "/v1/purchases/x")
    assert server.seen[0]["headers"]["idempotency-key"] == "my-key"
    assert "idempotency-key" not in server.seen[1]["headers"]


async def test_429_waits_retry_after_and_409_in_progress_is_retried(server: Scripted) -> None:
    server.script(
        problem(429, "rate-limited", headers={"retry-after": "1"}),
        problem(409, "idempotency-in-progress"),
        json_reply(201, {}),
    )
    t0 = time.monotonic()
    await post(client(server))
    assert len(server.seen) == 3 and time.monotonic() - t0 >= 1.0


async def test_422_and_409_purchase_exists_are_not_retried(server: Scripted) -> None:
    server.script(problem(422, "invalid-request"))
    with pytest.raises(keelson.UnprocessableEntityError):
        await post(client(server))
    assert len(server.seen) == 1
    server.script(problem(409, "purchase-exists", {"purchaseId": "P1"}))
    with pytest.raises(keelson.ConflictError) as err:
        await post(client(server))
    assert err.value.type == "purchase-exists" and err.value.problem["purchaseId"] == "P1"
    assert len(server.seen) == 1


async def test_stops_after_max_retries_and_raises_the_last_error(server: Scripted) -> None:
    server.script(*[problem(500, "internal")] * 3)
    with pytest.raises(keelson.InternalServerError):
        await post(client(server))
    assert len(server.seen) == 3


async def test_a_problem_maps_to_a_typed_error_with_the_request_id(server: Scripted) -> None:
    server.script(problem(404, "not-found", {"detail": "No such purchase."}))
    with pytest.raises(keelson.NotFoundError) as err:
        await client(server).request("GET", "/v1/purchases/x")
    e = err.value
    assert (e.status, e.type, e.detail, e.request_id) == (404, "not-found", "No such purchase.", "req_1")
    assert "No such purchase." in str(e)


async def test_a_401_invalid_token_refreshes_the_token_once(server: Scripted) -> None:
    class Counting:
        n = 0

        async def token(self, *, force: bool = False) -> str:
            self.n += 1
            return f"t{self.n - 1}"

    k = AsyncKeelson(Counting(), base_url=server.url)
    expired = problem(401, "unauthorized", headers={"www-authenticate": 'Bearer error="invalid_token"'})
    server.script(expired, json_reply(200, {"ok": 1}))
    await k.request("GET", "/v1/purchases/x")
    assert [r["headers"]["authorization"] for r in server.seen] == ["Bearer t0", "Bearer t1"]
    server.script(expired, expired)
    with pytest.raises(keelson.AuthenticationError):
        await k.request("GET", "/v1/purchases/x")
    assert len(server.seen) == 2


def test_an_http_base_url_that_is_not_loopback_is_refused() -> None:
    with pytest.raises(keelson.KeelsonError, match="https"):
        AsyncKeelson(static_token("t"), base_url="http://api.example.com")


async def test_a_countersign_that_never_gets_an_answer_is_outcome_unknown(server: Scripted) -> None:
    server.script(drop, drop, drop)
    with pytest.raises(keelson.OutcomeUnknownError) as err:
        await client(server).request("POST", "/v1/countersign", body={"requestId": "01JX0000000000000000000000"})
    assert err.value.request_id == "01JX0000000000000000000000"
    assert len({r["headers"]["idempotency-key"] for r in server.seen}) == 1


def test_the_blocking_client_runs_the_same_calls(server: Scripted) -> None:
    server.script(problem(503, "unavailable"), json_reply(201, {"ok": True}))
    k = Keelson(static_token("t0"), base_url=server.url)
    assert k.request("POST", "/v1/evidence", body={"a": 1}) == {"ok": True}
    assert len({r["headers"]["idempotency-key"] for r in server.seen}) == 1
    k.close()


async def test_a_countersign_still_in_progress_after_retries_is_outcome_unknown(server: Scripted) -> None:
    server.script(*[problem(409, "idempotency-in-progress")] * 3)
    with pytest.raises(keelson.OutcomeUnknownError):
        await client(server).request("POST", "/v1/countersign", body={"requestId": "01JX0000000000000000000001"})


def test_closing_the_blocking_client_stops_its_thread(server: Scripted) -> None:
    import threading

    before = threading.active_count()
    k = Keelson(static_token("t0"), base_url=server.url)
    k.close()
    time.sleep(0.2)
    assert threading.active_count() <= before


async def test_your_own_alibi_is_read_with_your_token_a_public_one_needs_none(server: Scripted) -> None:
    server.script(json_reply(200, {}), json_reply(200, {}))
    await client(server).alibis.retrieve("01M75ZQSJDFE8K76ZKZT08X1B2")
    await AsyncKeelson(None, base_url=server.url).alibis.retrieve("01M75ZQSJDFE8K76ZKZT08X1B2")
    assert [r["headers"].get("authorization") for r in server.seen] == ["Bearer t0", None]
