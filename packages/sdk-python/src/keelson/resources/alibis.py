from __future__ import annotations

from typing import Any, Literal
from urllib.parse import quote

from .._models import AlibiReceipt, AlibiReport
from ._base import Resource

ExportFormat = Literal["ap2", "vi", "ucp", "acp", "tap", "visa"]


class Alibis(Resource):
    async def retrieve(self, purchase_id: str) -> bytes:
        """The purchase's Alibi as issued: RFC 8785 JSON bytes, ready for ``verify_alibi``.

        Your own purchases' Alibis need your credentials; a live purchase's Alibi is public.
        """
        r = await self._call("GET", f"/v1/alibis/{quote(purchase_id, safe='')}", as_="bytes", auth="optional")
        data: bytes = r.data
        return data

    async def receipt(self, purchase_id: str) -> AlibiReceipt:
        """What the public log already publishes about the Alibi: leaf, inclusion proof, anchor."""
        r = await self._call("GET", f"/v1/alibis/{quote(purchase_id, safe='')}/receipt", auth=False)
        return AlibiReceipt.model_validate(r.data)

    async def pdf(self, purchase_id: str) -> bytes:
        """The Alibi as a PDF/A-3 with the bundle attached."""
        r = await self._call("GET", f"/v1/alibis/{quote(purchase_id, safe='')}.pdf", as_="bytes", auth="optional")
        data: bytes = r.data
        return data

    async def export(self, purchase_id: str, format: ExportFormat) -> dict[str, Any]:
        """The purchase in an agentic-commerce standard, signed by Keelson's attested enclave.

        AP2, Verifiable Intent, UCP, ACP, a Visa TAP request or the Visa evidence pack.
        """
        r = await self._call("GET", f"/v1/alibis/{quote(purchase_id, safe='')}/exports/{format}", auth="optional")
        data: dict[str, Any] = r.data
        return data

    async def verify_remote(self, alibi: bytes) -> AlibiReport:
        """Keelson's own check. To trust no one, use :func:`keelson.verify_alibi`."""
        r = await self._call(
            "POST",
            "/v1/alibis/verify",
            body=alibi,
            headers={"content-type": "application/vnd.keelson.alibi.v1+json"},
            auth=False,
        )
        return AlibiReport.model_validate(r.data)
