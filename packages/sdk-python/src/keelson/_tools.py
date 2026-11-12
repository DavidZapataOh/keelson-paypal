from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from importlib import resources
from typing import TYPE_CHECKING, Any

from ._errors import APIError, KeelsonError, OutcomeUnknownError
from ._sandbox import quote

if TYPE_CHECKING:
    from ._client import AsyncKeelson
    from .resources.mandates import Mandate

Envelope = dict[str, Any]
_PENDING = {"PROPOSED", "EVALUATING", "COUNTERSIGNED", "LOGGED", "COVERED"}
_SPECS: list[dict[str, Any]] = json.loads(resources.files(__package__).joinpath("_tools.json").read_text())


@dataclass
class KeelsonTool:
    """A framework-neutral tool, with the name, schema and answer of Keelson's MCP server."""

    name: str
    description: str
    input_schema: dict[str, Any]
    read_only: bool
    run: Callable[[dict[str, Any]], Awaitable[Envelope]]

    async def execute(self, arguments: dict[str, Any]) -> Envelope:
        """Runs the tool; a failure is an envelope the model reads, never an exception."""
        try:
            return await self.run(arguments)
        except OutcomeUnknownError as err:
            return {
                "status": "error",
                "next": {
                    "action": "poll",
                    "tool": "keelson_get_purchase",
                    "arguments": {"purchaseId": err.request_id},
                    "afterSeconds": 30,
                    "say": "The countersign was sent and its outcome is not known yet. Don't send it again; poll keelson_get_purchase.",
                },
                "message": str(err),
                "purchaseId": err.request_id,
                "outcome": "unknown",
                "retryable": False,
            }
        except Exception as err:
            retryable = isinstance(err, APIError) and err.status in (429, 503, 504)
            say = (
                "Keelson is busy or a dependency is down; nothing was done. Call the same tool once more in 30 seconds."
                if retryable
                else f"Tell the user it failed: {err}"
            )
            nxt: dict[str, Any] = (
                {"action": "poll", "tool": self.name, "afterSeconds": 30, "say": say}
                if retryable
                else {"action": "tell_user", "say": say}
            )
            return {"status": "error", "next": nxt, "message": str(err), "retryable": retryable}


def _money(minor: int, currency: str = "USD") -> str:
    return f"${minor / 100:,.2f}" if currency == "USD" else f"{minor / 100:,.2f} {currency}"


def tools(client: AsyncKeelson, *, agent_id: str | None = None) -> list[KeelsonTool]:
    """Keelson's tools for an agent framework, under the names of Keelson's MCP server."""
    held: dict[str, Mandate] = {}
    state: dict[str, str | None] = {"agent_id": agent_id}

    async def request_answer(request_id: str) -> Envelope:
        r = await client.requests.retrieve(request_id)
        state["agent_id"] = r.operatorAgentId
        s = r.state.value
        fields = {
            "requestId": r.id,
            "kind": r.kind.value,
            "state": s,
            "mandateId": r.mandateId,
            "approvalUrl": r.approvalUrl,
            "userCode": r.userCode,
            "matchNumber": r.matchNumber,
            "expiresAt": r.expiresAt,
        }
        if s == "PENDING":
            pick = f" and pick {r.matchNumber}" if r.matchNumber else ""
            return {
                "status": "pending_approval",
                "next": {
                    "action": "show_user_then_poll",
                    "tool": "keelson_get_request",
                    "arguments": {"requestId": r.id},
                    "afterSeconds": r.interval,
                    "say": f"Ask the user to approve at {r.approvalUrl}{pick}, then poll keelson_get_request.",
                },
                "message": "Waiting for the user's passkey.",
                **fields,
            }
        if s == "APPROVED":
            return {
                "status": "approved",
                "next": {
                    "action": "call",
                    "tool": "keelson_confirm_mandate",
                    "arguments": {"mandateId": r.mandateId},
                    "say": "The user signed. Confirm the mandate's PayPal hold with keelson_confirm_mandate.",
                },
                "message": f"The user approved mandate {r.mandateId}.",
                **fields,
            }
        return {
            "status": "denied",
            "next": {
                "action": "stop",
                "say": "The user declined or let it expire. Do not ask again unless they ask you to.",
            },
            "message": f"The request is {s.lower()}.",
            **fields,
        }

    async def mandate_of(mandate_id: str) -> Mandate:
        if mandate_id in held:
            return held[mandate_id]
        if not state["agent_id"]:
            raise KeelsonError("Read the request with keelson_get_request first.")
        found = next((m for m in await client.mandates.list(state["agent_id"]) if m.id == mandate_id), None)
        if found is None:
            raise KeelsonError(f"Mandate {mandate_id} is not active.")
        held[found.id] = found
        return found

    async def purchase_answer(purchase_id: str) -> Envelope:
        p = await client.purchases.retrieve(purchase_id)
        fields = {
            "purchaseId": p.id,
            "state": p.state,
            "amount": p.amount.model_dump(mode="json"),
            "logIndex": p.logIndex,
        }
        if p.state in _PENDING:
            return {
                "status": "approved",
                "next": {
                    "action": "poll",
                    "tool": "keelson_get_purchase",
                    "arguments": {"purchaseId": p.id},
                    "afterSeconds": 5,
                    "say": "Keelson allowed it; the capture is under way. Poll keelson_get_purchase.",
                },
                "message": f"Purchase {p.id} is {p.state}.",
                **fields,
            }
        if p.state == "CAPTURED":
            return {
                "status": "success",
                "next": {
                    "action": "stop",
                    "say": f"Bought. The Alibi is at https://verify.keelson.finance/?id={p.id}.",
                },
                "message": f"Purchase {p.id} is captured on PayPal.",
                **fields,
            }
        return {
            "status": "blocked" if p.state == "DENIED" else "error",
            "next": {"action": "tell_user", "say": f"Tell the user Keelson stopped it: {p.state}."},
            "message": f"Purchase {p.id} is {p.state}.",
            "retryable": False,
            **fields,
        }

    async def request_mandate(i: dict[str, Any]) -> Envelope:
        req = await client.mandates.request(
            name=i["name"],
            reason=i["reason"],
            per_purchase={"currency": "USD", "minor": i["perPurchaseMinor"]},
            total={"currency": "USD", "minor": i["totalMinor"]},
            until=i["until"],
            ask_above={"currency": "USD", "minor": i["askAboveMinor"]} if i.get("askAboveMinor") else None,
        )
        answer = await request_answer(req.id)
        return {**answer, "message": f"{i['name']} asks to spend up to {_money(i['totalMinor'])}. {answer['message']}"}

    async def get_request(i: dict[str, Any]) -> Envelope:
        return await request_answer(i["requestId"])

    async def request_change(i: dict[str, Any]) -> Envelope:
        req = await client.mandates.request_change(
            i["mandateId"],
            note=i["note"],
            per_purchase={"currency": "USD", "minor": i["perPurchaseMinor"]} if i.get("perPurchaseMinor") else None,
            total={"currency": "USD", "minor": i["totalMinor"]} if i.get("totalMinor") else None,
            until=i.get("until"),
        )
        return await request_answer(req.id)

    async def confirm(i: dict[str, Any]) -> Envelope:
        mid = i["mandateId"]
        held.pop(mid, None)
        try:
            m: Mandate | None = await mandate_of(mid)
        except KeelsonError:
            m = None
        if m is not None and m.authorizationId:
            return {
                "status": "success",
                "next": {
                    "action": "call",
                    "tool": "keelson_submit_evidence",
                    "arguments": {"mandateId": m.id},
                    "say": f"Mandate {m.id} is held: {_money(m.remainingMinor, m.currency)} left until {m.expiresAt}. Buy within it.",
                },
                "message": f"Mandate {m.id} is signed and held.",
                "mandate": {
                    "id": m.id,
                    "remainingMinor": m.remainingMinor,
                    "currency": m.currency,
                    "expiresAt": m.expiresAt.isoformat(),
                },
            }
        return {
            "status": "pending_approval",
            "next": {
                "action": "show_user_then_poll",
                "tool": "keelson_confirm_mandate",
                "arguments": {"mandateId": mid},
                "afterSeconds": 10,
                "say": f"Ask the user to approve the PayPal hold at https://app.keelson.finance/mandate?id={mid}, then poll keelson_confirm_mandate.",
            },
            "message": "No held mandate yet.",
        }

    async def submit_evidence(i: dict[str, Any]) -> Envelope:
        q = await asyncio.to_thread(quote, i["lines"])
        sealed = await client.evidence.seal(
            mandate_id=i["mandateId"], sources={**q["sources"], "observation": i["observation"]}
        )
        root = sealed["evidenceRoot"]
        return {
            "status": "success",
            "next": {
                "action": "call",
                "tool": "keelson_request_countersign",
                "arguments": {"mandateId": i["mandateId"], "evidenceRoot": root, "cart": q["cart"]},
                "say": "Check it with keelson_check_cart, then countersign it with keelson_request_countersign.",
            },
            "message": f"Evidence sealed under {root} for a cart of {_money(q['total']['minor'], q['total']['currency'])}.",
            "evidenceRoot": root,
            "cart": q["cart"],
            "total": q["total"],
            "items": sealed["items"],
        }

    async def check_cart(i: dict[str, Any]) -> Envelope:
        c = await client.mandates.check(i["mandateId"], i["cart"])
        blockers = c.blockers
        return {
            "status": "success" if c.canAttempt else "blocked",
            "next": {
                "action": "call",
                "tool": "keelson_request_countersign",
                "say": "It passes and needs the user's one-time approval; countersign to ask."
                if c.needsApproval
                else "It passes; countersign it.",
            }
            if c.canAttempt
            else {"action": "tell_user", "say": " ".join(b.next for b in blockers)},
            "message": "The cart passes the mandate." if c.canAttempt else " ".join(b.message for b in blockers),
            **c.model_dump(mode="json"),
        }

    async def countersign(i: dict[str, Any]) -> Envelope:
        signed = await client.purchases.countersign(
            mandate=await mandate_of(i["mandateId"]),
            evidence_root=i["evidenceRoot"],
            cart=i["cart"],
            repeat_of=i.get("repeatOf"),
        )
        if signed.approval:
            return await request_answer(signed.approval["request_id"])
        with contextlib.suppress(KeelsonError):
            await client.purchases.wait_for(signed.purchase_id, timeout=30)
        return await purchase_answer(signed.purchase_id)

    async def get_purchase(i: dict[str, Any]) -> Envelope:
        return await purchase_answer(i["purchaseId"])

    async def verify(i: dict[str, Any]) -> Envelope:
        pid = i["purchaseId"]
        report = await client.alibis.verify_remote(await client.alibis.retrieve(pid))
        url = f"https://verify.keelson.finance/?id={pid}"
        verdict = report.verdict.value
        return {
            "status": "blocked" if verdict == "failed" else "success",
            "next": {"action": "stop", "say": f"Anyone can check it in the browser at {url}."},
            "message": f"The Alibi is {verdict}.",
            "verdict": verdict,
            "checks": [
                {"id": c.id, "status": c.status.value, **({"reason": c.reason} if c.reason else {})}
                for c in report.checks
            ],
            "verifyUrl": url,
        }

    async def export(i: dict[str, Any]) -> Envelope:
        fmt = i["format"]
        try:
            artifact = await client.alibis.export(i["purchaseId"], fmt)
        except APIError as err:
            if err.status not in (409, 503):
                raise
            return {
                "status": "blocked",
                "next": {"action": "tell_user", "say": f"Tell the user this export is not available: {err}"},
                "message": str(err),
                "reason": str(err.problem.get("reason", "unavailable")),
            }
        say = (
            "Close the open mandates with your own agent key before presenting them."
            if "pending_close" in artifact
            else f"Hand the {fmt} export to whoever asked for it."
        )
        return {
            "status": "success",
            "next": {"action": "tell_user", "say": say},
            "message": f"The purchase as {fmt}, signed by Keelson's attested enclave.",
            "artifact": artifact,
        }

    async def grade(i: dict[str, Any]) -> Envelope:
        g = await client.operators.grade(i["agentId"])
        return {
            "status": "success",
            "next": {"action": "stop", "say": f"Operator {g.agentId} is graded {g.grade.value}."},
            "message": f"Operator {g.agentId} is graded {g.grade.value}.",
            **g.model_dump(mode="json"),
        }

    runs: dict[str, Callable[[dict[str, Any]], Awaitable[Envelope]]] = {
        "keelson_request_mandate": request_mandate,
        "keelson_get_request": get_request,
        "keelson_request_mandate_change": request_change,
        "keelson_confirm_mandate": confirm,
        "keelson_submit_evidence": submit_evidence,
        "keelson_check_cart": check_cart,
        "keelson_request_countersign": countersign,
        "keelson_get_purchase": get_purchase,
        "keelson_verify_alibi": verify,
        "keelson_export_alibi": export,
        "keelson_get_trust_grade": grade,
    }
    return [KeelsonTool(s["name"], s["description"], s["inputSchema"], s["readOnly"], runs[s["name"]]) for s in _SPECS]
