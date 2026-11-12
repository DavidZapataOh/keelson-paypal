from __future__ import annotations

import asyncio
import time
from datetime import datetime
from typing import Any
from urllib.parse import quote

from pydantic import BaseModel

from .._errors import MandateRequestClosedError
from .._models import CartCheck, DeviceAuthorization, OperatorMandate
from .._money import Amount, iso_of, minor_of
from ._base import Resource


class MandateRequest(BaseModel):
    """A request the user approves on Keelson's page with a passkey."""

    id: str
    approval_url: str
    user_code: str
    match_number: int | None
    expires_in: int
    interval: int


class Mandate(OperatorMandate):
    """An active mandate the agent may buy under, with the operator it names."""

    agent_id: str


def _request_of(data: Any) -> MandateRequest:
    d = DeviceAuthorization.model_validate(data)
    return MandateRequest(
        id=d.request_id,
        approval_url=d.verification_uri_complete,
        user_code=d.user_code,
        match_number=d.match_number,
        expires_in=d.expires_in,
        interval=d.interval,
    )


class Mandates(Resource):
    async def request(
        self,
        *,
        name: str,
        reason: str,
        per_purchase: Amount,
        total: Amount,
        until: str | datetime,
        ask_above: Amount | None = None,
    ) -> MandateRequest:
        """Asks the user to let the agent spend within limits; they approve with a passkey."""
        per, tot = minor_of(per_purchase), minor_of(total)
        limits: dict[str, Any] = {
            "currency": tot["currency"],
            "perPurchaseMinor": per["minor"],
            "totalMinor": tot["minor"],
            "until": iso_of(until),
        }
        if ask_above is not None:
            limits["askAboveMinor"] = minor_of(ask_above)["minor"]
        r = await self._call("POST", "/v1/connections", body={"name": name, "reason": reason, "limits": limits})
        return _request_of(r.data)

    async def request_change(
        self,
        mandate_id: str,
        *,
        note: str,
        per_purchase: Amount | None = None,
        total: Amount | None = None,
        until: str | datetime | None = None,
        ask_above: Amount | None = None,
    ) -> MandateRequest:
        """Asks the user to change a mandate's limits, with a one-line note they read."""
        limits: dict[str, Any] = {}
        if per_purchase is not None:
            limits["perPurchaseMinor"] = minor_of(per_purchase)["minor"]
        if total is not None:
            limits["totalMinor"] = minor_of(total)["minor"]
        if until is not None:
            limits["until"] = iso_of(until)
        if ask_above is not None:
            limits["askAboveMinor"] = minor_of(ask_above)["minor"]
        body: dict[str, Any] = {"note": note, **({"limits": limits} if limits else {})}
        r = await self._call("POST", f"/v1/mandates/{quote(mandate_id, safe='')}/changes", body=body)
        return _request_of(r.data)

    async def list(self, agent_id: str) -> list[Mandate]:
        """The active mandates naming the operator, newest first."""
        r = await self._call("GET", f"/v1/operators/{quote(agent_id, safe='')}/mandates")
        return [Mandate.model_validate({**m, "agent_id": agent_id}) for m in r.data["mandates"]]

    async def wait_for_approval(self, request_id: str, *, timeout: float = 900.0) -> Mandate:
        """Waits for the user's answer and the mandate's PayPal hold, then returns the mandate."""
        until = time.monotonic() + timeout
        while True:
            state = await self._client.requests.retrieve(request_id)
            s = state.state.value
            if s in ("DENIED", "EXPIRED"):
                raise MandateRequestClosedError(s)
            if s == "APPROVED" and state.mandateId:
                found = next(
                    (m for m in await self.list(state.operatorAgentId) if m.id == state.mandateId),
                    None,
                )
                if found and ((found.holdMode and found.holdMode.value == "per_purchase") or found.authorizationId):
                    return found
            if time.monotonic() > until:
                raise MandateRequestClosedError("EXPIRED")
            await asyncio.sleep(max(state.interval, 1))

    async def check(self, mandate_id: str, cart: dict[str, Any]) -> CartCheck:
        """Whether a countersign of this cart would pass the mandate as it stands, and why not."""
        r = await self._call("POST", f"/v1/mandates/{quote(mandate_id, safe='')}/check", body={"cart": cart})
        return CartCheck.model_validate(r.data)
