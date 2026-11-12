from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass

from .._errors import APIError
from ._base import Resource


@dataclass
class ServerEvent:
    id: str | None
    event: str
    data: str


class Events(Resource):
    async def stream(self, channel: str, *, last_event_id: str | None = None) -> AsyncIterator[ServerEvent]:
        """Live events of a channel; reconnects after a drop and resumes with ``Last-Event-ID``."""
        last = last_event_id
        failures = 0
        while True:
            try:
                r = await self._call(
                    "GET",
                    "/v1/events",
                    query={"channel": channel},
                    headers={"last-event-id": last} if last else {},
                    as_="stream",
                )
                try:
                    event_id, name = last, "message"
                    data: list[str] = []
                    async for line in r.response.aiter_lines():
                        if line == "":
                            if data:
                                failures = 0
                                yield ServerEvent(event_id, name, "\n".join(data))
                            name, data = "message", []
                        elif not line.startswith(":"):
                            field, _, value = line.partition(":")
                            value = value[1:] if value.startswith(" ") else value
                            if field == "data":
                                data.append(value)
                            elif field == "event":
                                name = value
                            elif field == "id":
                                event_id = last = value
                finally:
                    await r.response.aclose()
            except APIError as err:
                # A refusal (no access, bad channel) does not get better by asking again.
                if err.status < 500 and err.status != 429:
                    raise
                failures += 1
                if failures > 5:
                    raise
            except Exception:
                failures += 1
                if failures > 5:
                    raise
            await asyncio.sleep(min(0.5 * 2**failures, 8.0))
