from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

from .._transport import APIResponse, send

if TYPE_CHECKING:
    from .._client import AsyncKeelson


class Resource:
    def __init__(self, client: AsyncKeelson) -> None:
        self._client = client

    async def _call(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        query: dict[str, str | int | None] | None = None,
        headers: dict[str, str] | None = None,
        auth: bool | Literal["optional"] = True,
        as_: Literal["json", "bytes", "none", "stream"] = "json",
    ) -> APIResponse:
        return await send(
            self._client._transport,
            method,
            path,
            body=body,
            query=query,
            headers=headers,
            auth=auth,
            as_=as_,
        )
