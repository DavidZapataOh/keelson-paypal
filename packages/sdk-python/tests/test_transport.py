import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx2
import pytest

from keelson import BearerAuth, KeelsonTransport, Retry

# A local HTTP server answers with the statuses under test; the SDK's transport runs over the
# network against it exactly as it does against Keelson.
FAST = Retry(base_delay=0.001, max_delay=0.05)


class Server:
    def __init__(self) -> None:
        self.answers: list[tuple[int, dict[str, str], bytes]] = []
        self.seen: list[dict[str, str]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self) -> None:
                length = int(self.headers.get("content-length", 0))
                self.rfile.read(length)
                outer.seen.append({k.lower(): v for k, v in self.headers.items()})
                index = min(len(outer.seen), len(outer.answers)) - 1
                status, headers, body = outer.answers[index]
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = do_POST = _answer

            def log_message(self, *args: object) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"


@pytest.fixture
def server() -> Iterator[Server]:
    s = Server()
    yield s
    s.httpd.shutdown()


def client(retry: Retry = FAST, **kwargs: object) -> httpx2.Client:
    return httpx2.Client(transport=KeelsonTransport(retry), **kwargs)  # type: ignore[arg-type]


def test_a_post_keeps_one_idempotency_key_across_its_retries(server: Server) -> None:
    server.answers = [(503, {}, b"{}"), (502, {}, b"{}"), (201, {}, b"{}")]
    response = client().post(server.url, json={})
    assert response.status_code == 201
    keys = {h.get("idempotency-key") for h in server.seen}
    assert len(server.seen) == 3 and len(keys) == 1 and None not in keys


def test_a_key_the_caller_set_is_sent_as_is_and_gets_carry_none(server: Server) -> None:
    server.answers = [(200, {}, b"{}")]
    c = client()
    c.post(server.url, json={}, headers={"idempotency-key": "mine"})
    c.get(server.url)
    assert server.seen[0]["idempotency-key"] == "mine"
    assert "idempotency-key" not in server.seen[1]


def test_429_and_an_in_progress_request_are_retried(server: Server) -> None:
    problem = b'{"type":"https://keelson.finance/problems/idempotency-in-progress"}'
    server.answers = [(429, {"retry-after": "0"}, b"{}"), (409, {}, problem), (200, {}, b"{}")]
    assert client().post(server.url, json={}).status_code == 200
    assert len(server.seen) == 3


def test_retries_stop_and_refusals_are_not_retried(server: Server) -> None:
    server.answers = [(503, {}, b"{}")]
    assert client(Retry(max_retries=2, base_delay=0.001)).get(server.url).status_code == 503
    assert len(server.seen) == 3
    server.seen.clear()
    server.answers = [(422, {}, b"{}")]
    assert client().get(server.url).status_code == 422
    assert len(server.seen) == 1


def test_an_invalid_token_is_refreshed_once(server: Server) -> None:
    server.answers = [
        (401, {"www-authenticate": 'Bearer error="invalid_token"'}, b"{}"),
        (200, {}, b"{}"),
    ]

    class Tokens:
        n = 0

        def token(self) -> str:
            return f"t{self.n}"

        async def atoken(self) -> str:
            return self.token()

        def invalidate(self) -> None:
            self.n += 1

    assert client(auth=BearerAuth(Tokens())).get(server.url).status_code == 200
    assert [h["authorization"] for h in server.seen] == ["Bearer t0", "Bearer t1"]
