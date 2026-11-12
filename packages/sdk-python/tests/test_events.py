from __future__ import annotations

import time
from http.server import BaseHTTPRequestHandler

from keelson import AsyncKeelson, static_token

from .conftest import Reply, Scripted


def sse(body: str) -> Reply:
    def reply(h: BaseHTTPRequestHandler) -> None:
        data = body.encode()
        h.send_response(200)
        h.send_header("content-type", "text/event-stream")
        h.send_header("content-length", str(len(data)))
        h.end_headers()
        h.wfile.write(data)

    return reply


async def test_a_dropped_stream_resumes_after_the_servers_retry_with_last_event_id(server: Scripted) -> None:
    server.script(
        sse('retry: 1500\n: connected\n\nid: 7\nevent: c\ndata: {"n":1}\n\n'),
        sse('retry: 1500\n: connected\n\nid: 8\nevent: c\ndata: {"n":2}\n\n'),
    )
    k = AsyncKeelson(static_token("t0"), base_url=server.url, timeout=2.0)
    events = k.events.stream("c")
    first = await anext(events)
    ended = time.monotonic()
    second = await anext(events)
    await events.aclose()  # type: ignore[attr-defined]
    assert (first.id, first.data, second.id, second.data) == ("7", '{"n":1}', "8", '{"n":2}')
    assert server.seen[1]["headers"]["last-event-id"] == "7"
    assert time.monotonic() - ended >= 1.5
