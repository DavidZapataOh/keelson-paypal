from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

from .._agent_key import close_mandate
from .._errors import (
    APIConnectionError,
    ConflictError,
    InternalServerError,
    KeelsonError,
    NotFoundError,
    OutcomeUnknownError,
)
from .._models import Purchase
from .._money import paypal_value
from ._base import Resource
from .mandates import Mandate

_A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_PENDING = {"PROPOSED", "EVALUATING", "COUNTERSIGNED", "LOGGED", "COVERED"}


def _ulid() -> str:
    t = int(time.time() * 1000)
    head = "".join(_A[(t >> (5 * i)) & 31] for i in range(9, -1, -1))
    return head + "".join(_A[b & 31] for b in os.urandom(16))


@dataclass
class CountersignResult:
    """What a countersign answered."""

    purchase_id: str
    decision: str | None
    """``None`` while the cart waits for the user's one-time approval."""
    approval: dict[str, str] | None
    """``{"request_id", "approval_url"}``: send the user there, then countersign again."""
    existing: bool
    """This cart was already bought; this is that purchase."""
    countersigned: dict[str, Any] | None


def _approval_of(a: Any) -> dict[str, str] | None:
    if isinstance(a, dict) and a.get("request_id") and a.get("verification_uri_complete"):
        return {"request_id": a["request_id"], "approval_url": a["verification_uri_complete"]}
    return None


class Purchases(Resource):
    async def countersign(
        self,
        *,
        mandate: Mandate,
        evidence_root: str,
        cart: dict[str, Any],
        repeat_of: str | None = None,
    ) -> CountersignResult:
        """Asks Keelson's two TEEs to countersign the cart under the mandate.

        Safe to call again after an error: the same cart under the same mandate is one purchase.
        When the answer is lost it raises :class:`OutcomeUnknownError`; read the outcome with
        :meth:`wait_for`, never send it again.
        """
        if not mandate.holdMode or mandate.holdMode.value != "mandate" or not mandate.authorizationId:
            raise KeelsonError("This mandate holds each purchase separately; use one held as a whole.")
        request_id = _ulid()
        key = self._client._agent_key()
        authority: dict[str, Any] = (
            {"closedMandate": close_mandate(mandate.openMandate, request_id=request_id, cart=cart, key=key)}
            if key is not None
            else {"mandateId": mandate.id, "requestId": request_id}
        )
        total = sum(line["qty"] * line["unit_minor"] for line in cart["lines"])
        value = paypal_value(cart["currency"], total)
        body: dict[str, Any] = {
            "authorizationId": mandate.authorizationId,
            **authority,
            "cart": cart,
            "unit": {
                "amount": {
                    "currency_code": cart["currency"],
                    "value": value,
                    "breakdown": {"item_total": {"currency_code": cart["currency"], "value": value}},
                }
            },
            "evidenceRoot": evidence_root,
        }
        if repeat_of:
            body["repeatOf"] = repeat_of
        try:
            r = await self._call("POST", "/v1/countersign", body=body)
        except ConflictError as err:
            if err.type == "purchase-exists":
                return CountersignResult(str(err.problem["purchaseId"]), None, None, True, None)
            if err.type == "approval-required":
                return CountersignResult("", None, _approval_of(err.problem.get("approval")), False, None)
            raise
        except (APIConnectionError, InternalServerError) as err:
            raise OutcomeUnknownError(request_id) from err
        data: dict[str, Any] = r.data
        return CountersignResult(
            data.get("purchaseId") or request_id,
            data.get("decision"),
            _approval_of(data.get("approval")),
            False,
            data,
        )

    async def retrieve(self, purchase_id: str) -> Purchase:
        r = await self._call("GET", f"/v1/purchases/{quote(purchase_id, safe='')}")
        return Purchase.model_validate(r.data)

    async def wait_for(self, purchase_id: str, *, timeout: float = 120.0) -> Purchase:
        """Waits until the purchase is captured, denied or failed."""
        until = time.monotonic() + timeout
        while True:
            try:
                p: Purchase | None = await self.retrieve(purchase_id)
            except NotFoundError:
                p = None
            if p is not None and p.state not in _PENDING:
                return p
            if time.monotonic() > until:
                raise KeelsonError(f"Purchase {purchase_id} is still {p.state if p else 'unknown'}.")
            await asyncio.sleep(1)
