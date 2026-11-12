from __future__ import annotations

import json
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

Reply = Callable[[BaseHTTPRequestHandler], None]


def json_reply(status: int, body: Any, headers: dict[str, str] | None = None) -> Reply:
    def reply(h: BaseHTTPRequestHandler) -> None:
        data = json.dumps(body).encode()
        h.send_response(status)
        h.send_header("content-type", "application/json")
        h.send_header("content-length", str(len(data)))
        for k, v in (headers or {}).items():
            h.send_header(k, v)
        h.end_headers()
        h.wfile.write(data)

    return reply


def problem(
    status: int, slug: str, extra: dict[str, Any] | None = None, headers: dict[str, str] | None = None
) -> Reply:
    body = {
        "type": f"https://api.keelson.finance/problems/{slug}",
        "title": slug.replace("-", " "),
        "status": status,
        "instance": "/",
        **(extra or {}),
    }
    return json_reply(status, body, {"x-request-id": "req_1", **(headers or {})})


def drop(h: BaseHTTPRequestHandler) -> None:
    h.close_connection = True
    h.connection.shutdown(2)


@dataclass
class Scripted:
    url: str
    seen: list[dict[str, Any]] = field(default_factory=list)
    queue: list[Reply] = field(default_factory=list)

    def script(self, *replies: Reply) -> None:
        self.seen.clear()
        self.queue[:] = list(replies)


@pytest.fixture
def server() -> Iterator[Scripted]:
    """A real HTTP server on 127.0.0.1 that answers each request with the next scripted reply."""
    state: Scripted

    class Handler(BaseHTTPRequestHandler):
        def _any(self) -> None:
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length).decode() if length else ""
            state.seen.append(
                {
                    "method": self.command,
                    "path": self.path,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "body": body,
                }
            )
            (state.queue.pop(0) if state.queue else problem(500, "unscripted"))(self)

        do_GET = do_POST = do_PUT = _any

        def log_message(self, *args: Any) -> None:
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    state = Scripted(f"http://127.0.0.1:{httpd.server_address[1]}")
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield state
    httpd.shutdown()
