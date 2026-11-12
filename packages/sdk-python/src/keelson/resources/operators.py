from __future__ import annotations

from typing import Any
from urllib.parse import quote

from .._models import Operator, TrustGrade
from ._base import Resource


class Operators(Resource):
    async def link(self, *, chain_id: int, agent_id: str, name: str, cnf_jwk: dict[str, Any]) -> Operator:
        """Links your ERC-8004 agent to this OAuth client, so mandates can name it."""
        body = {"chainId": chain_id, "agentId": agent_id, "name": name, "cnfJwk": cnf_jwk}
        return Operator.model_validate((await self._call("POST", "/v1/operators", body=body)).data)

    async def grade(self, agent_id: str) -> TrustGrade:
        """The operator's public trust grade, from its covered purchases and incidents."""
        r = await self._call("GET", f"/v1/operators/{quote(agent_id, safe='')}/grade", auth=False)
        return TrustGrade.model_validate(r.data)

    async def announce_run(
        self, agent_id: str, mandate_id: str, *, state: str, live_view_url: str | None = None
    ) -> None:
        """Tells the mandate's owner the agent started or ended a run."""
        body: dict[str, Any] = {
            "state": state,
            **({"liveViewUrl": live_view_url} if live_view_url else {}),
        }
        path = f"/v1/operators/{quote(agent_id, safe='')}/mandates/{quote(mandate_id, safe='')}/runs"
        await self._call("POST", path, body=body, as_="none")
