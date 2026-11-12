from __future__ import annotations

from urllib.parse import quote

from .._models import ConnectionRequestState
from ._base import Resource


class Requests(Resource):
    async def retrieve(self, request_id: str) -> ConnectionRequestState:
        """A mandate request's state; reading it changes nothing."""
        r = await self._call("GET", f"/v1/connections/requests/{quote(request_id, safe='')}")
        return ConnectionRequestState.model_validate(r.data)
