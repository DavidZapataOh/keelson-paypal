"""Keelson for an agent: the same steps and answers as Keelson's MCP tools, as SDK calls.

Every write answers an envelope, ``{"status", "next", "message"}`` plus its own fields, and is
never called again to finish what it started: :meth:`KeelsonAgent.get_request` and
:meth:`KeelsonAgent.get_purchase` are the polls. ``next["tool"]`` names the MCP tool, whose method
here has the same name without the ``keelson.`` prefix.
"""

from __future__ import annotations

import base64
import time
from typing import Any, Literal, NotRequired, TypedDict, cast

from cryptography.hazmat.primitives.asymmetric import ec

from .client import KeelsonError, unwrap
from .evidence import Cart, build_manifest, cart_hash, seal
from .generated.api.connections import get_connection_request, request_mandate
from .generated.api.evidence import store_evidence
from .generated.api.mandates import check_cart, request_mandate_change
from .generated.api.operators import list_operator_mandates
from .generated.api.purchases import get_purchase
from .generated.api.tee import countersign
from .generated.client import AuthenticatedClient
from .generated.models import (
    CheckCartBody,
    ConnectionRequest,
    CountersignRequest,
    EvidenceUpload,
    MandateChangeRequest,
)
from .mandate import close_mandate
from .money import to_paypal_value
from .ulid import new_ulid

Status = Literal["pending_approval", "approved", "denied", "blocked", "success", "error"]
"""``pending_approval``: the user has to answer first. ``approved``: the user or Keelson said yes
and the work continues on its own. ``denied``: the user said no. ``blocked``: Keelson refused it
under the mandate. ``success``: done, for good. ``error``: it failed; ``retryable`` says whether
calling again is safe."""


class Next(TypedDict):
    """Exactly what the agent does next."""

    action: Literal["show_user_then_poll", "poll", "call", "tell_user", "stop"]
    say: str
    tool: NotRequired[str]
    arguments: NotRequired[dict[str, Any]]
    afterSeconds: NotRequired[int]


class Envelope(TypedDict, total=False):
    status: Status
    next: Next
    message: str
    retryable: bool


_CAPTURED_OR_AFTER = frozenset(
    {
        "CAPTURED",
        "DELIVERED",
        "SETTLED",
        "DISPUTED",
        "ATTRIBUTED",
        "SLASHED",
        "WARRANTY_PAID",
        "DEFENDED",
        "MERCHANT_LIABLE",
    }
)


def _envelope(status: Status, next: Next, message: str, **fields: Any) -> Envelope:
    return cast(Envelope, {"status": status, "next": next, "message": message, **fields})


def _failed(err: Exception, tool: str) -> Envelope:
    retryable = isinstance(err, KeelsonError) and err.status in (429, 503, 504)
    if retryable:
        next: Next = {
            "action": "poll",
            "tool": tool,
            "afterSeconds": 30,
            "say": "Keelson is busy or a dependency is down; nothing was done. Call the same tool once more in 30 seconds.",
        }
    else:
        next = {"action": "tell_user", "say": f"Tell the user it failed: {err}"}
    return _envelope("error", next, str(err), retryable=retryable)


def _request_answer(r: dict[str, Any]) -> Envelope:
    fields = {
        "requestId": r["id"],
        "kind": r["kind"],
        "state": r["state"],
        "approvalUrl": r["approvalUrl"],
        "userCode": r["userCode"],
        "matchNumber": r["matchNumber"],
        "expiresAt": r["expiresAt"],
        "mandateId": r["mandateId"],
    }
    poll = {"tool": "keelson.get_request", "arguments": {"requestId": r["id"]}}
    if r["state"] == "PENDING":
        number = (
            ""
            if r["matchNumber"] is None
            else f" and the number {r['matchNumber']}, which they pick on the page"
        )
        return _envelope(
            "pending_approval",
            {
                **poll,  # type: ignore[typeddict-item]
                "action": "show_user_then_poll",
                "afterSeconds": r["interval"],
                "say": f"Show the user this link{number}: {r['approvalUrl']}. Then poll keelson.get_request every {r['interval']} seconds.",
            },
            "Waiting for the user to approve with a passkey.",
            **fields,
        )
    if r["state"] == "APPROVED":
        next: Next = (
            {
                "action": "call",
                "tool": "keelson.request_countersign",
                "arguments": {"mandateId": r["mandateId"]},
                "say": f"The user approved this one cart under mandate {r['mandateId']}: countersign the same cart and evidence under it. It allows that cart only.",
            }
            if r["kind"] == "once"
            else {
                "action": "call",
                "tool": "keelson.confirm_mandate",
                "arguments": {"mandateId": r["mandateId"]},
                "say": "The user approved. Wait for the PayPal hold with keelson.confirm_mandate before buying.",
            }
        )
        return _envelope("approved", next, f"Approved: mandate {r['mandateId']}.", **fields)
    if r["state"] == "DENIED":
        return _envelope(
            "denied",
            {
                "action": "stop",
                "say": "The user said no. Do not ask again unless they tell you to.",
            },
            "The user declined.",
            **fields,
        )
    return _envelope(
        "error",
        {
            "action": "tell_user",
            "say": "The request expired before the user answered. Ask them whether to ask again.",
        },
        "The request expired.",
        retryable=False,
        **fields,
    )


def _purchase_answer(p: dict[str, Any]) -> Envelope:
    reasons = p.get("reasons") or []
    fields = {
        "purchaseId": p["id"],
        "mandateId": p["mandateId"],
        "state": p["state"],
        "amount": {"currency": p["amount"]["currency"], "minor": int(p["amount"]["minor"])},
        "logIndex": p.get("logIndex"),
        "failure": p.get("failure"),
        "reasons": reasons,
    }
    poll: Next = {
        "action": "poll",
        "tool": "keelson.get_purchase",
        "arguments": {"purchaseId": p["id"]},
        "afterSeconds": 5,
        "say": "",
    }
    state = p["state"]
    if state in _CAPTURED_OR_AFTER:
        return _envelope(
            "success",
            {
                "action": "tell_user",
                "say": f"Bought. PayPal captured it; its Alibi is at keelson.get_alibi {p['id']}.",
            },
            f"Purchase {p['id']} is captured."
            if state == "CAPTURED"
            else f"Purchase {p['id']} was captured; it is now {state}.",
            outcome="known",
            **fields,
        )
    if state == "DENIED":
        why = "; ".join(
            f"{r['field']}: the mandate allows {r.get('mandate') or 'nothing'}, the cart has {r.get('cart') or 'nothing'}"
            for r in reasons
        )
        return _envelope(
            "blocked",
            {
                "action": "tell_user",
                "say": f"Keelson blocked this cart{f' ({why})' if why else ''}. Do not retry the same cart; change it, or ask for more room with keelson.request_mandate_change.",
            },
            "Keelson blocked the cart under the mandate.",
            outcome="known",
            **fields,
        )
    if state == "FAILED":
        failure = p.get("failure") or {}
        # A capture that failed after it was sent may still have moved the money.
        unknown = failure.get("step") == "capture"
        next: Next = (
            {
                **poll,
                "afterSeconds": 120,
                "say": "We don't know yet whether PayPal charged this purchase. Don't start it again; check again in a few minutes.",
            }
            if unknown
            else {
                "action": "tell_user",
                "say": f"It failed at {failure.get('step', 'a step')} ({failure.get('reason', 'unknown')}); nothing was captured.",
            }
        )
        return _envelope(
            "error",
            next,
            "The outcome is not known yet."
            if unknown
            else "The purchase failed; nothing was captured.",
            outcome="unknown" if unknown else "known",
            retryable=False,
            **fields,
        )
    return _envelope(
        "approved",
        {**poll, "say": f"Countersigned; it is {state}. Poll keelson.get_purchase until success."},
        f"Purchase {p['id']} is {state}.",
        outcome="pending",
        **fields,
    )


class KeelsonAgent:
    """Keelson for an agent.

    ``agent_key`` is the agent's ``cnf`` key, where it lives: its countersigns are closed with
    it. Leave it out for an app acting for a user, whose mandates Keelson closes with its hosted
    operator's key. ``agent_id`` is the operator's ERC-8004 agent id, which its mandates name.
    """

    def __init__(
        self,
        client: AuthenticatedClient,
        *,
        agent_id: int | str | None = None,
        agent_key: ec.EllipticCurvePrivateKey | None = None,
    ) -> None:
        self.client = client
        self._agent_id = None if agent_id is None else str(agent_id)
        self._agent_key = agent_key

    def get_request(self, request_id: str) -> Envelope:
        """Reads a request to the user. Safe to call every ``next["afterSeconds"]``."""
        try:
            state = unwrap(get_connection_request.sync_detailed(id=request_id, client=self.client))
            return _request_answer(state.to_dict())
        except Exception as err:
            return _failed(err, "keelson.get_request")

    def _asked(self, request_id: str) -> Envelope:
        try:
            state = unwrap(get_connection_request.sync_detailed(id=request_id, client=self.client))
            return _request_answer(state.to_dict())
        except Exception:
            return _envelope(
                "pending_approval",
                {
                    "action": "poll",
                    "tool": "keelson.get_request",
                    "arguments": {"requestId": request_id},
                    "afterSeconds": 5,
                    "say": "The request was made. Poll keelson.get_request for its link and the user's answer.",
                },
                "The request was made; its state could not be read yet.",
                requestId=request_id,
            )

    def request_mandate(
        self,
        *,
        name: str,
        reason: str,
        per_purchase_minor: int,
        total_minor: int,
        until: str,
        ask_above_minor: int | None = None,
        currency: str = "USD",
    ) -> Envelope:
        """Asks the user for a mandate (RFC 8628 device authorization): show ``approvalUrl`` with
        ``matchNumber``, then poll :meth:`get_request`. Amounts are minor units; ``until`` is an
        RFC 3339 date-time; ``reason`` (100 to 1000 characters) is what the user reads."""
        limits: dict[str, Any] = {
            "currency": currency,
            "perPurchaseMinor": per_purchase_minor,
            "totalMinor": total_minor,
            "until": until,
        }
        if ask_above_minor is not None:
            limits["askAboveMinor"] = ask_above_minor
        try:
            body = ConnectionRequest.from_dict({"name": name, "reason": reason, "limits": limits})
            made = unwrap(request_mandate.sync_detailed(client=self.client, body=body))
        except Exception as err:
            return _failed(err, "keelson.request_mandate")
        # The request exists now: whatever happens next, the agent polls it, never asks again.
        return self._asked(made.request_id)

    def request_mandate_change(
        self,
        mandate_id: str,
        *,
        note: str,
        per_purchase_minor: int | None = None,
        total_minor: int | None = None,
        until: str | None = None,
    ) -> Envelope:
        """Asks the user for more room on a mandate, with a one-line note they read verbatim."""
        change: dict[str, Any] = {"note": note}
        for key, value in (
            ("perPurchaseMinor", per_purchase_minor),
            ("totalMinor", total_minor),
            ("until", until),
        ):
            if value is not None:
                change[key] = value
        try:
            made = unwrap(
                request_mandate_change.sync_detailed(
                    id=mandate_id, client=self.client, body=MandateChangeRequest.from_dict(change)
                )
            )
        except Exception as err:
            return _failed(err, "keelson.request_mandate_change")
        return self._asked(made.request_id)

    def _operator(self, agent_id: int | str | None) -> str:
        operator = str(agent_id) if agent_id is not None else self._agent_id
        if operator is None:
            raise ValueError("Name the operator's agent_id.")
        return operator

    def list_mandates(self, agent_id: int | str | None = None) -> list[dict[str, Any]]:
        """The active mandates naming the operator, newest first."""
        listed = unwrap(
            list_operator_mandates.sync_detailed(
                agent_id=self._operator(agent_id), client=self.client
            )
        )
        return [m.to_dict() for m in listed.mandates]

    def confirm_mandate(
        self, mandate_id: str | None = None, *, agent_id: int | str | None = None
    ) -> Envelope:
        """Finds the signed mandate with its PayPal hold. Safe to poll."""
        try:
            mandates = self.list_mandates(agent_id)
        except Exception as err:
            return _failed(err, "keelson.confirm_mandate")
        found = next(
            (
                m
                for m in mandates
                if (m["id"] == mandate_id if mandate_id else m["authorizationId"] is not None)
            ),
            None,
        )
        if found and found["authorizationId"] is not None:
            return _envelope(
                "success",
                {
                    "action": "call",
                    "tool": "keelson.submit_evidence",
                    "arguments": {"mandateId": found["id"]},
                    "say": f"Mandate {found['id']} is held: {found['remainingMinor']} {found['currency']} minor units left until {found['expiresAt']}. Buy within it.",
                },
                f"Mandate {found['id']} is signed and held.",
                mandate=found,
            )
        return _envelope(
            "pending_approval",
            {
                "action": "poll",
                "tool": "keelson.confirm_mandate",
                "arguments": {"mandateId": mandate_id} if mandate_id else {},
                "afterSeconds": 10,
                "say": "The user has not signed the mandate or approved its PayPal hold yet; poll keelson.confirm_mandate.",
            },
            "No signed and held mandate yet.",
            mandate=found,
        )

    def submit_evidence(
        self, mandate_id: str, *, product: Any, cart: Cart, observation: str
    ) -> Envelope:
        """Seals what the agent saw at decision time (the store's product and cart answers and its
        own observation, verbatim and without personal data, each salted) and stores the
        manifest with Keelson. Returns the evidence root to countersign under."""
        try:
            items = seal(product, cart, observation)
            manifest = build_manifest(items)
            upload = EvidenceUpload.from_dict(
                {
                    "mandateId": mandate_id,
                    "manifest": manifest,
                    "items": [
                        {
                            "type": i.type,
                            "mediaType": i.media_type,
                            "salt": base64.b64encode(i.salt).decode(),
                            "bytes": base64.b64encode(i.data).decode(),
                        }
                        for i in items
                    ],
                }
            )
            root = unwrap(
                store_evidence.sync_detailed(client=self.client, body=upload)
            ).evidence_root
        except Exception as err:
            return _failed(err, "keelson.submit_evidence")
        return _envelope(
            "success",
            {
                "action": "call",
                "tool": "keelson.check_cart",
                "arguments": {"mandateId": mandate_id, "evidenceRoot": root, "cart": cart},
                "say": "Check it with keelson.check_cart, then countersign it with keelson.request_countersign.",
            },
            f"Evidence sealed under {root}.",
            evidenceRoot=root,
            cart=cart,
            items=[i.type for i in items],
        )

    def check_cart(self, mandate_id: str, cart: Cart) -> Envelope:
        """A dry run of the countersign: what would pass, field by field. Nothing is signed or
        reserved."""
        try:
            check = unwrap(
                check_cart.sync_detailed(
                    id=mandate_id, client=self.client, body=CheckCartBody.from_dict({"cart": cart})
                )
            ).to_dict()
        except Exception as err:
            return _failed(err, "keelson.check_cart")
        if not check["canAttempt"]:
            return _envelope(
                "blocked",
                {
                    "action": "tell_user",
                    "say": " ".join(f"{b['message']} {b['next']}" for b in check["blockers"]),
                },
                "This cart would not pass the mandate.",
                **check,
            )
        return _envelope(
            "success",
            {
                "action": "call",
                "tool": "keelson.request_countersign",
                "say": "It passes, and is above the user's ask-me amount: the countersign pauses it for their one-time approval."
                if check["needsApproval"]
                else "It passes. Countersign it once.",
            },
            "This cart would pass the mandate.",
            **check,
        )

    def request_countersign(
        self,
        mandate_id: str,
        *,
        evidence_root: str,
        cart: Cart,
        agent_id: int | str | None = None,
        repeat_of: str | None = None,
    ) -> Envelope:
        """Asks Keelson to countersign the cart under the mandate with its evidence. On allow the
        purchase is logged, covered by the operator's bond and captured on PayPal. Send it once:
        on anything but a refusal, poll :meth:`get_purchase` with the ``purchaseId`` it returns.
        ``repeat_of`` only when the user asked to buy this same cart again."""
        sent: str | None = None
        try:
            mandate = next((m for m in self.list_mandates(agent_id) if m["id"] == mandate_id), None)
            if mandate is None:
                raise ValueError(f"Mandate {mandate_id} is not active for this operator.")
            if mandate["holdMode"] != "mandate" or mandate["authorizationId"] is None:
                raise ValueError(
                    "This mandate holds each purchase separately; buy under a mandate held as a whole."
                )
            request_id = new_ulid()
            authority: dict[str, str] = (
                {
                    "closedMandate": close_mandate(
                        mandate["openMandate"], request_id, cart_hash(cart), self._agent_key
                    )
                }
                if self._agent_key is not None
                else {"mandateId": mandate_id, "requestId": request_id}
            )
            total = sum(line["qty"] * line["unit_minor"] for line in cart["lines"])
            value = to_paypal_value(cart["currency"], total)
            body = CountersignRequest.from_dict(
                {
                    "authorizationId": mandate["authorizationId"],
                    **authority,
                    "cart": cart,
                    "unit": {
                        "amount": {
                            "currency_code": cart["currency"],
                            "value": value,
                            "breakdown": {
                                "item_total": {"currency_code": cart["currency"], "value": value}
                            },
                        }
                    },
                    "evidenceRoot": evidence_root,
                    **({"repeatOf": repeat_of} if repeat_of else {}),
                }
            )
            purchase_id = request_id
            sent = request_id
            approval: dict[str, Any] | None = None
            try:
                signed = unwrap(countersign.sync_detailed(client=self.client, body=body)).to_dict()
                purchase_id = signed.get("purchaseId", request_id)
                approval = signed.get("approval")
            except KeelsonError as err:
                # A retry after a lost answer: the purchase already made of this cart is the answer.
                if err.type == "purchase-exists" and isinstance(err.problem.get("purchaseId"), str):
                    purchase_id = sent = err.problem["purchaseId"]
                # Above the user's ask-me amount: paused before any TEE saw it.
                elif err.type == "approval-required":
                    approval = err.problem.get("approval")
                else:
                    raise
            if approval and approval.get("request_id"):
                return self._asked(approval["request_id"])
            return _purchase_answer(
                unwrap(get_purchase.sync_detailed(id=purchase_id, client=self.client)).to_dict()
            )
        except Exception as err:
            # A refusal answered before anything ran may be retried; anything after the send is polled.
            refused = (
                isinstance(err, KeelsonError) and 400 <= err.status < 500 and err.status != 429
            )
            if sent and not refused:
                return _envelope(
                    "error",
                    {
                        "action": "poll",
                        "tool": "keelson.get_purchase",
                        "arguments": {"purchaseId": sent},
                        "afterSeconds": 30,
                        "say": "The countersign was sent and its outcome is not known yet. Don't send it again; poll keelson.get_purchase.",
                    },
                    str(err),
                    purchaseId=sent,
                    outcome="unknown",
                    retryable=False,
                )
            return _failed(err, "keelson.request_countersign")

    def get_purchase(self, purchase_id: str) -> Envelope:
        """Reads a purchase. Safe to call every ``next["afterSeconds"]``."""
        try:
            return _purchase_answer(
                unwrap(get_purchase.sync_detailed(id=purchase_id, client=self.client)).to_dict()
            )
        except Exception as err:
            return _failed(err, "keelson.get_purchase")

    def settle(self, envelope: Envelope, *, timeout: float = 900.0) -> Envelope:
        """Follows an envelope's polls, ``next["afterSeconds"]`` apart, until it says something
        else to do or ``timeout`` seconds pass."""
        until = time.monotonic() + timeout
        current = envelope
        while current["next"]["action"] in ("poll", "show_user_then_poll") and (
            time.monotonic() < until
        ):
            time.sleep(current["next"].get("afterSeconds", 5))
            args = current["next"].get("arguments", {})
            tool = current["next"].get("tool")
            if tool == "keelson.get_request":
                current = self.get_request(args["requestId"])
            elif tool == "keelson.get_purchase":
                current = self.get_purchase(args["purchaseId"])
            elif tool == "keelson.confirm_mandate":
                current = self.confirm_mandate(args.get("mandateId"))
            else:
                break
        return current
