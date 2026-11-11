from __future__ import annotations

import base64
from typing import Any

from .._seal import manifest_of, sealed_items
from ._base import Resource


class Evidence(Resource):
    async def seal(self, *, mandate_id: str, sources: dict[str, Any]) -> dict[str, Any]:
        """Seals what the agent saw; returns ``{"evidenceRoot", "items"}``.

        ``sources`` holds ``product`` and ``cart`` (the store's answers) and ``observation``
        (what the agent read, verbatim, with no personal data).
        """
        items = sealed_items(sources)
        r = await self._call(
            "POST",
            "/v1/evidence",
            body={
                "mandateId": mandate_id,
                "manifest": manifest_of(items),
                "items": [
                    {
                        "type": i.type,
                        "mediaType": i.media_type,
                        "salt": base64.b64encode(i.salt).decode(),
                        "bytes": base64.b64encode(i.content).decode(),
                    }
                    for i in items
                ],
            },
        )
        return {"evidenceRoot": r.data["evidenceRoot"], "items": [i.type for i in items]}
